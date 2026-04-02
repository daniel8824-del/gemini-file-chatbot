import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Paperclip, Send, FileText, Loader2, Bot, User, Database, CheckCircle2, AlertCircle, Key, Terminal, Trash2, PanelRight, PanelRightClose, Info, Upload, Check, ChevronUp, ChevronDown, ChevronRight, X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const processCitations = (text: string, groundingMetadata: any) => {
  if (!groundingMetadata?.groundingChunks) return { text, citations: [] };

  const chunks = groundingMetadata.groundingChunks;
  const supports = groundingMetadata.groundingSupports || [];

  const uniqueChunks: any[] = [];
  const chunkIndexMap = new Map<number, number>();

  chunks.forEach((chunk: any, index: number) => {
    const title = chunk.retrievedContext?.title || chunk.web?.title || '문서';
    const uri = chunk.retrievedContext?.uri || chunk.web?.uri || '';
    
    let page = '';
    const metadata = chunk.retrievedContext?.customMetadata;
    if (metadata && Array.isArray(metadata)) {
      const pageMeta = metadata.find((m: any) => m.key === 'page_number' || m.key === 'page');
      if (pageMeta) {
        page = String(pageMeta.numericValue ?? pageMeta.stringValue ?? '');
      }
    }

    const existingIndex = uniqueChunks.findIndex(c => c.title === title && c.uri === uri && c.page === page);
    
    if (existingIndex !== -1) {
      chunkIndexMap.set(index, existingIndex);
    } else {
      uniqueChunks.push({ ...chunk, title, uri, page });
      chunkIndexMap.set(index, uniqueChunks.length - 1);
    }
  });

  let annotatedText = text;
  
  if (supports.length > 0) {
    try {
      const sortedSupports = [...supports].sort((a, b) => (b.segment?.endIndex || 0) - (a.segment?.endIndex || 0));
      
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let bytes = encoder.encode(text);
      
      for (const support of sortedSupports) {
        if (!support.segment || support.segment.endIndex === undefined) continue;
        const indices = support.groundingChunkIndices || [];
        if (indices.length === 0) continue;
        
        const mappedIndices = Array.from(new Set(indices.map((i: number) => chunkIndexMap.get(i))))
          .filter(i => i !== undefined)
          .sort((a, b) => (a as number) - (b as number));
          
        if (mappedIndices.length === 0) continue;
        
        const citationString = ` [${mappedIndices.map(i => (i as number) + 1).join(', ')}]`;
        const citationBytes = encoder.encode(citationString);
        
        const endIndex = support.segment.endIndex;
        
        if (endIndex > bytes.length) continue;

        const newBytes = new Uint8Array(bytes.length + citationBytes.length);
        newBytes.set(bytes.slice(0, endIndex), 0);
        newBytes.set(citationBytes, endIndex);
        newBytes.set(bytes.slice(endIndex), endIndex + citationBytes.length);
        bytes = newBytes;
      }
      annotatedText = decoder.decode(bytes);
    } catch (e) {
      console.error("Failed to inject inline citations", e);
    }
  }

  return { text: annotatedText, citations: uniqueChunks };
};

type Message = {
  id: string;
  role: 'user' | 'model';
  text: string;
  citations?: any[];
  attachments?: File[];
};

type StoreFile = {
  name: string;
  type: string;
  status: 'uploading' | 'processing' | 'ready' | 'error';
};

export default function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [usingUserKey, setUsingUserKey] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'model',
      text: '안녕하세요! **Gemini File Search API (RAG)** 기반 문서 분석 챗봇입니다.\n\n우측 상단의 **스토어 관리** 버튼을 눌러 Store를 생성하고 문서를 업로드하세요. 하단의 클립 모양 버튼으로 문서를 첨부하거나, 입력창에서 질문하면 문서 기반 답변을 받을 수 있습니다.',
    },
  ]);
  const [input, setInput] = useState('');
  const [chatAttachments, setChatAttachments] = useState<File[]>([]);
  
  const [storeName, setStoreName] = useState<string | null>('fileSearchStores/v2-bydr3us66oqo');
  const [storeFiles, setStoreFiles] = useState<StoreFile[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sidebarFileInputRef = useRef<HTMLInputElement>(null);

  // UI States
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [uploadTargetStore, setUploadTargetStore] = useState<string | null>(null);
  const [isFilesExpanded, setIsFilesExpanded] = useState(false);

  // Debug & Management States
  const [logs, setLogs] = useState<string[]>([]);
  const [isTesting, setIsTesting] = useState(false);
  const [isFetchingData, setIsFetchingData] = useState(false);
  const [existingStores, setExistingStores] = useState<any[]>([]);
  const [existingFiles, setExistingFiles] = useState<any[]>([]);
  const [expandedStores, setExpandedStores] = useState<Record<string, boolean>>({});
  const logsEndRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const toggleStore = (storeName: string) => {
    setExpandedStores(prev => ({ ...prev, [storeName]: !prev[storeName] }));
  };

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyError, setApiKeyError] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);

  const getApiKey = () => {
    return localStorage.getItem('GEMINI_API_KEY') || (import.meta.env.VITE_GEMINI_API_KEY || '');
  };

  const handleSaveKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) { setApiKeyError('API 키를 입력해주세요.'); return; }
    setIsSavingKey(true);
    setApiKeyError('');
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'test' });
      localStorage.setItem('GEMINI_API_KEY', key);
      setHasKey(true);
      setUsingUserKey(true);
    } catch (e: any) {
      setApiKeyError('API 키가 유효하지 않습니다. 다시 확인해주세요.');
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('GEMINI_API_KEY');
    setHasKey(false);
    setApiKeyInput('');
  };

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  useEffect(() => {
    const key = getApiKey();
    if (key) {
      setHasKey(true);
      setUsingUserKey(true);
    } else {
      setHasKey(false);
    }
  }, []);

  useEffect(() => {
    if (hasKey) {
      fetchStoresAndFiles();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey]);

  useEffect(() => {
    if (isSidebarOpen && hasKey) {
      fetchStoresAndFiles();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarOpen]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, logs]);

  // ==========================================
  // Store & File Management Logic
  // ==========================================
  const fetchStoresAndFiles = async () => {
    setIsFetchingData(true);
    setLogs([]);
    addLog('데이터 조회 중...');
    try {
      const ai = new GoogleGenAI({ apiKey: getApiKey() });
      
      addLog('Store 목록 가져오는 중...');
      const stores = await ai.fileSearchStores.list();
      const sList = [];
      for await (const s of stores) {
        sList.push(s);
      }
      setExistingStores(sList);
      addLog(`✅ Store ${sList.length}개 발견.`);

      addLog('문서 목록 가져오는 중...');
      const allDocs = [];
      for (const s of sList) {
        if (!s.name) continue;
        try {
          const docs = await ai.fileSearchStores.documents.list({ parent: s.name });
          for await (const d of docs) {
            allDocs.push({ ...d, storeName: s.name, storeDisplayName: s.displayName });
          }
        } catch (e) {
          console.error(`Failed to fetch docs for store ${s.name}`, e);
        }
      }
      setExistingFiles(allDocs);
      addLog(`✅ 문서 ${allDocs.length}개 발견.`);
      
    } catch (error: any) {
      addLog(`❌ 조회 실패: ${error.message}`);
    } finally {
      setIsFetchingData(false);
    }
  };

  const runStoreTest = async () => {
    setIsTesting(true);
    addLog('테스트 Store 생성 중...');
    try {
      const ai = new GoogleGenAI({ apiKey: getApiKey() });
      const store = await ai.fileSearchStores.create({
        config: { displayName: 'test-store-' + Date.now() }
      });
      addLog(`🎉 Store 생성 성공: ${store.displayName || store.name}`);
      await fetchStoresAndFiles();
    } catch (error: any) {
      addLog(`❌ 생성 실패: ${error.message}`);
    } finally {
      setIsTesting(false);
    }
  };

  const handleDeleteStore = async (storeNameToDelete: string) => {
    setIsFetchingData(true);
    addLog(`Store 삭제 중: ${storeNameToDelete}`);
    try {
      const ai = new GoogleGenAI({ apiKey: getApiKey() });
      await ai.fileSearchStores.delete({ name: storeNameToDelete, config: { force: true } });
      addLog(`✅ Store 삭제 성공: ${storeNameToDelete}`);
      showToast('스토어가 삭제되었습니다.');
      if (storeName === storeNameToDelete) {
        setStoreName(null);
      }
      await fetchStoresAndFiles();
    } catch (error: any) {
      addLog(`❌ 삭제 실패: ${error.message}`);
      showToast(`삭제 실패: ${error.message}`);
      setIsFetchingData(false);
    }
  };

  const handleDeleteDocument = async (documentName: string) => {
    setIsFetchingData(true);
    addLog(`문서 삭제 중: ${documentName}`);
    try {
      const ai = new GoogleGenAI({ apiKey: getApiKey() });
      await ai.fileSearchStores.documents.delete({ name: documentName });
      addLog(`✅ 문서 삭제 성공: ${documentName}`);
      showToast('문서가 삭제되었습니다.');
      await fetchStoresAndFiles();
    } catch (error: any) {
      addLog(`❌ 삭제 실패: ${error.message}`);
      showToast(`삭제 실패: ${error.message}`);
      setIsFetchingData(false);
    }
  };

  // ==========================================
  // Chat & Upload Logic
  // ==========================================
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    
    const newFiles = Array.from(e.target.files);
    setChatAttachments(prev => [...prev, ...newFiles]);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSidebarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    
    const newFiles = Array.from(e.target.files);
    const documents = newFiles.filter(f => !f.type.startsWith('image/'));
    
    if (documents.length > 0 && uploadTargetStore) {
      await processDocumentsForStore(documents, uploadTargetStore);
    } else if (documents.length === 0) {
      showToast('File Search Store는 PDF, TXT, CSV 등의 문서 파일만 지원합니다.');
    }
    
    if (sidebarFileInputRef.current) {
      sidebarFileInputRef.current.value = '';
    }
    setUploadTargetStore(null);
  };

  const processDocumentsForStore = async (documents: File[], specificStoreName?: string) => {
    let step = '초기화';
    try {
      const ai = new GoogleGenAI({ apiKey: getApiKey() });
      
      let currentStoreName = specificStoreName || storeName;
      
      if (!currentStoreName) {
        step = 'Store 생성';
        const store = await ai.fileSearchStores.create({
          config: { displayName: 'rag-store-' + Date.now() }
        });
        currentStoreName = store.name || '';
      }
      setStoreName(currentStoreName);

      const newStoreFiles: StoreFile[] = documents.map(f => ({
        name: f.name,
        type: f.type,
        status: 'uploading'
      }));
      setStoreFiles(prev => [...prev, ...newStoreFiles]);
      setIsFilesExpanded(true); // Auto-expand when uploading

      // 5개씩 배치 처리
      const BATCH_SIZE = 5;
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (file) => {
          let currentStep = `파일 업로드 (${file.name})`;
          try {
            let operation = await ai.fileSearchStores.uploadToFileSearchStore({
              file: file,
              fileSearchStoreName: currentStoreName,
              config: {
                displayName: file.name,
                mimeType: file.type || 'application/octet-stream'
              }
            });

            setStoreFiles(prev => prev.map(f => f.name === file.name ? { ...f, status: 'processing' } : f));

            currentStep = `처리 대기 (${file.name})`;
            if (operation.name) {
              while (!operation.done) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                operation = await ai.operations.get({ operation });
              }
            }

            setStoreFiles(prev => prev.map(f => f.name === file.name ? { ...f, status: 'ready' } : f));
          } catch (err: any) {
            console.error(`Error in step [${currentStep}]:`, err);
            setStoreFiles(prev => prev.map(f => f.name === file.name ? { ...f, status: 'error' } : f));
            // 개별 파일 실패가 전체 실패로 이어지지 않도록 throw 생략하거나 별도 처리
          }
        }));
        if (i + BATCH_SIZE < documents.length) {
          await delay(1500);
        }
      }

      const failedCount = storeFiles.filter(f => f.status === 'error').length;
      if (failedCount > 0) {
        alert(`${documents.length - failedCount}개 성공, ${failedCount}개 실패`);
      }
      
      if (isSidebarOpen) {
        fetchStoresAndFiles();
      }
    } catch (error: any) {
      console.error('Error creating store or uploading:', error);
      const errorMessage = error?.message || '';
      showToast(`오류가 발생했습니다. 단계: ${step}`);
    }
  };

  const fileToGenerativePart = async (file: File) => {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: {
        data: await base64EncodedDataPromise,
        mimeType: file.type || 'application/octet-stream'
      }
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && chatAttachments.length === 0) || isLoading) return;
    
    if (storeFiles.some(f => f.status === 'uploading' || f.status === 'processing')) {
      showToast('문서 처리가 완료될 때까지 잠시만 기다려주세요.');
      return;
    }

    const userMessageId = Date.now().toString();
    const currentInput = input;
    const currentAttachments = [...chatAttachments];

    setInput('');
    setChatAttachments([]);
    setIsLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey: getApiKey() });

      const newUserMessage: Message = {
        id: userMessageId,
        role: 'user',
        text: currentInput,
        attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
      };

      setMessages((prev) => [...prev, newUserMessage]);

      const contents = messages.slice(1).map((msg) => ({
        role: msg.role,
        parts: [{ text: msg.text }]
      }));
      
      const currentParts: any[] = [];
      if (currentInput.trim()) {
        currentParts.push({ text: currentInput });
      }
      
      for (const file of currentAttachments) {
        const part = await fileToGenerativePart(file);
        currentParts.push(part);
      }

      contents.push({ role: 'user', parts: currentParts });

      const modelMessageId = (Date.now() + 1).toString();
      setMessages((prev) => [...prev, { id: modelMessageId, role: 'model', text: '' }]);

      const config: any = {};
      if (storeName) {
        config.tools = [{ fileSearch: { fileSearchStoreNames: [storeName] } }];
      }

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents,
        config: Object.keys(config).length > 0 ? config : undefined,
      });

      let fullResponse = response.text || '';
      let citations: any[] = [];

      if (response.candidates?.[0]?.groundingMetadata) {
        const processed = processCitations(fullResponse, response.candidates[0].groundingMetadata);
        fullResponse = processed.text;
        citations = processed.citations;
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === modelMessageId ? { ...msg, text: fullResponse, citations: citations.length > 0 ? citations : msg.citations } : msg
        )
      );
    } catch (error: any) {
      console.error('Error generating response:', error);
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: 'model', text: '죄송합니다. 오류가 발생했습니다. 다시 시도해 주세요.' },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  if (hasKey === false) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#F9FAFB] font-sans">
        <div className="bg-white p-10 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-gray-100 text-center max-w-md w-full mx-4">
          <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Key className="w-8 h-8 text-blue-600" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-3 tracking-tight">API 키가 필요합니다</h2>
          <p className="text-gray-500 mb-6 leading-relaxed text-sm">
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline font-medium">Google AI Studio</a>에서 무료 API 키를 발급받으세요.
          </p>
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
            placeholder="API 키를 입력하세요"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 mb-4 transition"
          />
          {apiKeyError && <p className="text-red-500 text-xs mb-4">{apiKeyError}</p>}
          <button
            onClick={handleSaveKey}
            disabled={isSavingKey}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition shadow-sm disabled:opacity-50"
          >
            {isSavingKey ? '확인 중...' : '저장'}
          </button>
          <p className="text-gray-400 text-xs mt-4">키는 이 브라우저에만 저장됩니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#F9FAFB] font-sans overflow-hidden">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white px-6 py-3 rounded-full shadow-lg text-sm font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-4">
          <Info className="w-4 h-4 text-blue-400" />
          {toast}
        </div>
      )}

      {/* Main Chat Area */}
      <div className={cn("flex-1 flex flex-col transition-all duration-300 ease-in-out relative min-w-0", isSidebarOpen ? "mr-96" : "mr-0")}>
        <header className="bg-white/80 backdrop-blur-md border-b border-gray-100 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-sm shadow-blue-200">
              <Database className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900 tracking-tight">File Search 챗봇</h1>
              <p className="text-xs text-gray-500 font-medium">Gemini RAG Engine</p>
            </div>
          </div>
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className={cn(
              "p-2.5 rounded-xl transition-all duration-200 flex items-center gap-2 text-sm font-medium",
              isSidebarOpen ? "bg-blue-50 text-blue-600" : "bg-white text-gray-600 hover:bg-gray-50 border border-gray-200 shadow-sm"
            )}
          >
            {isSidebarOpen ? <PanelRightClose className="w-5 h-5" /> : <PanelRight className="w-5 h-5" />}
            <span className="hidden sm:inline">{isSidebarOpen ? '패널 닫기' : '스토어 관리'}</span>
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 scroll-smooth">
          <div className="max-w-3xl mx-auto space-y-8 pb-4">
            {messages.map((message) => (
              <div key={message.id} className={cn('flex gap-4', message.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
                <div className={cn('w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-1 shadow-sm', message.role === 'user' ? 'bg-gray-100 border border-gray-200' : 'bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 text-blue-600')}>
                  {message.role === 'user' ? <User className="w-5 h-5 text-gray-500" /> : <Bot className="w-5 h-5" />}
                </div>
                <div className={cn(
                  'max-w-[85%] px-6 py-4 shadow-sm transition-all',
                  message.role === 'user' 
                    ? 'bg-gradient-to-br from-blue-600 to-indigo-600 text-white rounded-3xl rounded-tr-sm shadow-md' 
                    : 'bg-white border border-gray-100/50 text-gray-800 rounded-3xl rounded-tl-sm shadow-[0_2px_10px_rgb(0,0,0,0.02)]'
                )}>
                  
                  <div className={cn('prose prose-sm max-w-none break-words leading-relaxed dark:prose-invert prose-headings:font-bold prose-strong:font-bold prose-li:my-0.5 prose-table:text-sm', message.role === 'user' ? 'prose-invert' : '')}>
                    {message.role === 'model' && message.text === '' && isLoading ? (
                      <div className="flex items-center gap-3 text-gray-500 py-1">
                        <div className="flex gap-1.5 items-center h-5">
                          <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                          <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                          <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                        </div>
                        <span className="text-sm font-medium ml-1 text-gray-400">답변 생성 중...</span>
                      </div>
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                    )}
                  </div>

                  {/* RAG Citations */}
                  {message.citations && message.citations.length > 0 && (
                    <div className="mt-5 pt-4 border-t border-gray-100/20">
                      <p className={cn("text-xs font-semibold mb-2 flex items-center gap-1.5", message.role === 'user' ? "text-blue-200" : "text-gray-400")}>
                        <FileText className="w-3.5 h-3.5" />
                        참고 문서 (Citations)
                      </p>
                      <ul className={cn("text-xs space-y-1.5 list-none", message.role === 'user' ? "text-blue-100" : "text-gray-500")}>
                        {message.citations.map((citation, idx) => {
                          const title = citation.title || citation.retrievedContext?.title || citation.web?.title || '문서';
                          const uri = citation.uri || citation.retrievedContext?.uri || citation.web?.uri;
                          const page = citation.page;
                          return (
                            <li key={idx} className="flex items-start gap-2">
                              <span className="text-[10px] opacity-50 mt-0.5">[{idx + 1}]</span>
                              <div className="flex flex-col">
                                {uri ? <a href={uri} target="_blank" rel="noreferrer" className="hover:underline opacity-90 hover:opacity-100 transition-opacity">{title}</a> : <span>{title}</span>}
                                {page && <span className="text-[10px] opacity-70">페이지: {page}</span>}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </main>

        <div className="bg-gradient-to-t from-[#F9FAFB] via-[#F9FAFB] to-transparent pt-6 pb-6 px-4">
          <div className="max-w-3xl mx-auto">
            {/* Active Store & Upload Progress */}
            {(storeName || chatAttachments.length > 0) && (
              <div className="mb-3 flex flex-wrap items-center gap-2 px-2">
                {storeName && (
                  <div className="flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-blue-700 px-3 py-1.5 rounded-full text-xs font-medium shadow-sm">
                    <Database className="w-3.5 h-3.5" />
                    <span className="truncate max-w-[200px]">
                      {existingStores.find(s => s.name === storeName)?.displayName || storeName}
                    </span>
                    <span className="flex items-center gap-1 ml-1 text-[10px] font-bold text-blue-500 bg-blue-100 px-1.5 py-0.5 rounded-full">
                      <Check className="w-3 h-3" /> ACTIVE
                    </span>
                  </div>
                )}
                
                {chatAttachments.map((file, index) => (
                  <div key={index} className="flex items-center gap-1.5 bg-white border border-gray-200 pl-2.5 pr-1 py-1 rounded-full text-[11px] text-gray-600 font-medium shadow-sm group">
                    <FileText className="w-3 h-3 text-gray-400" />
                    <span className="truncate max-w-[120px]">{file.name}</span>
                    <button 
                      type="button"
                      onClick={() => setChatAttachments(prev => prev.filter((_, i) => i !== index))}
                      className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex items-end gap-2 bg-white/90 backdrop-blur-md border border-gray-200/50 rounded-[28px] p-2 shadow-[0_8px_30px_rgb(0,0,0,0.06)] focus-within:ring-4 focus-within:ring-blue-500/10 focus-within:border-blue-400 transition-all duration-300">
              <input type="file" multiple ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="application/pdf,text/plain,.csv,.doc,.docx,.md,image/*,audio/*,video/*" />
              <button type="button" onClick={() => fileInputRef.current?.click()} className="p-3.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-colors shrink-0 focus:outline-none" title="파일 첨부">
                <Paperclip className="w-5 h-5" />
              </button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder="메시지를 입력하거나 문서를 첨부하세요..."
                className="flex-1 max-h-32 min-h-[44px] bg-transparent border-none focus:outline-none focus:ring-0 resize-none py-3.5 px-2 text-gray-900 placeholder:text-gray-400 font-medium text-sm"
                rows={1}
              />
              <button type="submit" disabled={(!input.trim() && chatAttachments.length === 0) || isLoading} className="p-3.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 transition-all shrink-0 shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-2">
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5 ml-0.5" />}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Right Panel: Sidebar (Toggleable) */}
      <div className={cn(
        "fixed top-0 right-0 h-full w-96 bg-[#111827] flex flex-col text-gray-300 font-sans text-sm shadow-2xl transition-transform duration-300 ease-in-out z-40",
        isSidebarOpen ? "translate-x-0" : "translate-x-full"
      )}>
        <div className="p-5 border-b border-gray-800 flex items-center justify-between bg-[#0B0F19]">
          <div className="flex items-center gap-2.5">
            <Database className="w-5 h-5 text-blue-400" />
            <h2 className="font-bold text-gray-100 tracking-wide">Store 관리</h2>
            {usingUserKey && (
              <span className="ml-2 px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded text-[10px] uppercase tracking-wider font-bold">
                Gemini Key
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={fetchStoresAndFiles}
              disabled={isFetchingData}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {isFetchingData ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
              조회
            </button>
            <button
              onClick={runStoreTest}
              disabled={isTesting}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {isTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5" />}
              생성
            </button>
          </div>
        </div>
        
        <div className="flex-1 p-5 overflow-y-auto space-y-6 custom-scrollbar">
          <input type="file" multiple ref={sidebarFileInputRef} onChange={handleSidebarFileChange} className="hidden" accept="application/pdf,text/plain,.csv,.doc,.docx,.md" />
          
          {/* Explanation Box */}
          <div className="bg-blue-900/20 border border-blue-800/50 rounded-xl p-4 text-xs text-blue-200 leading-relaxed">
            <strong className="text-blue-400 flex items-center gap-1.5 mb-2 text-sm">
              <Info className="w-4 h-4" /> 청킹(Chunking) 및 메타데이터
            </strong>
            Gemini File Search API는 내부적으로 문서를 최적의 크기로 <strong>자동 청킹 및 임베딩</strong>합니다. 
            개발자가 직접 청크 사이즈나 오버랩을 설정할 필요 없이, 문서 원본만 업로드하면 구글의 RAG 엔진이 알아서 인덱싱을 완료합니다.
          </div>

          {/* Stores & Documents List */}
          <div>
            <h3 className="text-gray-400 font-bold mb-3 text-xs uppercase tracking-wider flex items-center justify-between">
              <span>Stores ({existingStores.length})</span>
            </h3>
            {existingStores.length === 0 ? (
              <div className="bg-gray-800/30 rounded-xl p-4 text-center border border-gray-800 border-dashed">
                <p className="text-gray-500 text-xs">조회 버튼을 눌러 확인하세요.</p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {existingStores.map((s, i) => {
                  const storeDocs = existingFiles.filter(f => f.storeName === s.name);
                  const isExpanded = expandedStores[s.name];
                  
                  return (
                    <li key={i} className={cn("rounded-xl border transition-all", storeName === s.name ? "bg-blue-900/20 border-blue-500/50" : "bg-gray-800/40 border-gray-700/50 hover:border-gray-600")}>
                      <div className="p-3.5 flex items-start justify-between gap-2 group">
                        <div className="min-w-0 flex-1 cursor-pointer flex items-start gap-2" onClick={() => toggleStore(s.name)}>
                          <div className="mt-0.5 text-gray-500">
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <div className={cn("font-semibold truncate text-sm", storeName === s.name ? "text-blue-400" : "text-gray-300")}>{s.displayName || s.name}</div>
                              {storeName === s.name && <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded text-[9px] uppercase tracking-wider font-bold flex items-center gap-1"><Check className="w-3 h-3"/> Active</span>}
                            </div>
                            <div className="text-gray-500 text-[10px] mt-1 font-mono truncate">{s.name}</div>
                            <div className="text-gray-500 text-[11px] mt-1.5 flex items-center gap-2">
                              <span>생성일: {s.createTime ? new Date(s.createTime).toLocaleDateString() : 'N/A'}</span>
                              <span className="w-1 h-1 rounded-full bg-gray-600"></span>
                              <span>문서 {storeDocs.length}개</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button 
                            onClick={(e) => { e.stopPropagation(); setStoreName(s.name); showToast('이 Store가 채팅에 활성화되었습니다.'); }}
                            className="p-2 text-gray-500 hover:text-blue-400 hover:bg-blue-400/10 rounded-lg transition-colors"
                            title="채팅에 활성화"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); setUploadTargetStore(s.name); sidebarFileInputRef.current?.click(); }}
                            className="p-2 text-gray-500 hover:text-green-400 hover:bg-green-400/10 rounded-lg transition-colors"
                            title="이 Store에 문서 업로드"
                          >
                            <Upload className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleDeleteStore(s.name); }}
                            className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                            title="Store 삭제"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      
                      {/* Expanded Documents List */}
                      {isExpanded && (
                        <div className="border-t border-gray-700/50 bg-gray-900/30 p-3 rounded-b-xl">
                          {storeDocs.length === 0 ? (
                            <div className="text-center py-3 text-gray-500 text-xs italic">
                              이 스토어에 문서가 없습니다.
                            </div>
                          ) : (
                            <ul className="space-y-2">
                              {storeDocs.map((f, j) => (
                                <li key={j} className="bg-gray-800/60 p-2.5 rounded-lg border border-gray-700/30 group/doc flex items-center justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-gray-300 font-medium truncate text-xs">{f.displayName || f.name}</div>
                                    <div className="text-gray-500 text-[10px] mt-1 flex items-center gap-2">
                                      <span className="truncate max-w-[100px] font-mono">{f.mimeType || 'unknown'}</span>
                                      <span className="font-mono">{f.sizeBytes ? (parseInt(f.sizeBytes) / 1024).toFixed(1) + ' KB' : ''}</span>
                                      <span className="flex items-center gap-1">
                                        <span className={cn("w-1.5 h-1.5 rounded-full", f.state === 'ACTIVE' ? "bg-green-500" : "bg-yellow-500")}></span>
                                        {f.state || 'ACTIVE'}
                                      </span>
                                    </div>
                                  </div>
                                  <button 
                                    onClick={() => handleDeleteDocument(f.name)}
                                    className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors opacity-0 group-hover/doc:opacity-100 shrink-0"
                                    title="문서 삭제"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Logs */}
          <div className="pt-6 border-t border-gray-800">
            <h3 className="text-gray-400 font-bold mb-3 text-xs uppercase tracking-wider">Logs</h3>
            <div className="space-y-1.5 bg-gray-950 p-3 rounded-xl border border-gray-800/50 font-mono">
              {logs.length === 0 ? (
                <div className="text-gray-600 italic text-xs text-center py-2">로그가 없습니다.</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className={cn(
                    "break-words text-[11px] leading-relaxed",
                    log.includes('✅') || log.includes('🎉') ? "text-green-400" : 
                    log.includes('❌') ? "text-red-400" : 
                    log.includes('💡') ? "text-yellow-400" : "text-gray-400"
                  )}>
                    {log}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Play, Square, Loader2, Globe, Settings, Terminal, Activity, CheckCircle2, AlertCircle, Zap, Trash2, Plus, LogIn, LogOut, Save, FolderOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from "@google/genai";
import { auth, db, signInWithGoogle, logout, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, setDoc, getDoc, onSnapshot, collection, addDoc, query, orderBy, serverTimestamp, Timestamp, deleteDoc } from 'firebase/firestore';

// Error Boundary Component
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null
  };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    const { hasError, error } = this.state;
    const { children } = (this as any).props;

    if (hasError) {
      let errorMessage = "Something went wrong.";
      try {
        const parsed = JSON.parse(error?.message || "");
        if (parsed.error) errorMessage = `Firestore Error: ${parsed.error} (${parsed.operationType} at ${parsed.path})`;
      } catch (e) {
        errorMessage = error?.message || errorMessage;
      }

      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-red-500/50 rounded-xl p-8 max-w-md w-full text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-white mb-2">Application Error</h2>
            <p className="text-slate-300 mb-6">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-6 rounded-lg transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return children;
  }
}

// Generate a simple unique ID for the session if not exists
const getSessionId = () => {
  let id = localStorage.getItem('bot_session_id');
  if (!id) {
    id = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('bot_session_id', id);
  }
  return id;
};

const SESSION_ID = getSessionId();

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [url, setUrl] = useState('');
  const [trafficType, setTrafficType] = useState<'direct' | 'organic'>('direct');
  const [organicUrls, setOrganicUrls] = useState(['', '', '', '']);
  const [keywords, setKeywords] = useState('');
  const [enableKeywords, setEnableKeywords] = useState(false);
  const [visits, setVisits] = useState(1000);
  const [minPerVisit, setMinPerVisit] = useState(1);
  const [headless, setHeadless] = useState(true);
  const [useProxies, setUseProxies] = useState(false);
  const [smartAI, setSmartAI] = useState(true);
  const [proxyCount, setProxyCount] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [currentVisit, setCurrentVisit] = useState(0);
  const [totalVisits, setTotalVisits] = useState(0);
  const [currentAction, setCurrentAction] = useState<string | null>(null);
  const [lastCompletedVisit, setLastCompletedVisit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiQuotaCooldown, setAiQuotaCooldown] = useState(false);
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    const saved = localStorage.getItem('bot_api_keys');
    return saved ? JSON.parse(saved) : [];
  });
  const [newApiKey, setNewApiKey] = useState('');
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [ws, setWs] = useState<WebSocket | null>(null);
  const [savedConfigs, setSavedConfigs] = useState<any[]>([]);
  const [showConfigModal, setShowConfigModal] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Load user settings (API keys) from Firestore
  useEffect(() => {
    if (!user) {
      setApiKeys([]);
      return;
    }

    const userDocRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.apiKeys) {
          setApiKeys(data.apiKeys);
        }
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
    });

    return () => unsubscribe();
  }, [user]);

  // Load saved configs from Firestore
  useEffect(() => {
    if (!user) {
      setSavedConfigs([]);
      return;
    }

    const configsRef = collection(db, 'users', user.uid, 'configs');
    const q = query(configsRef, orderBy('createdAt', 'desc'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const configs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setSavedConfigs(configs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/configs`);
    });

    return () => unsubscribe();
  }, [user]);

  const saveApiKeyToFirestore = async (newKeys: string[]) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid), {
        apiKeys: newKeys,
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
    }
  };

  const saveConfig = async (name: string) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'users', user.uid, 'configs'), {
        name,
        url,
        trafficType,
        visits,
        minPerVisit,
        headless,
        useProxies,
        smartAI,
        keywords,
        organicUrls,
        createdAt: serverTimestamp()
      });
      setShowConfigModal(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/configs`);
    }
  };

  const loadConfig = (config: any) => {
    setUrl(config.url || '');
    setTrafficType(config.trafficType || 'direct');
    setVisits(config.visits || 1000);
    setMinPerVisit(config.minPerVisit || 1);
    setHeadless(config.headless !== undefined ? config.headless : true);
    setUseProxies(config.useProxies || false);
    setSmartAI(config.smartAI !== undefined ? config.smartAI : true);
    setKeywords(config.keywords || '');
    setOrganicUrls(config.organicUrls || ['', '', '', '']);
    setShowConfigModal(false);
  };

  const deleteConfig = async (configId: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'configs', configId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `users/${user.uid}/configs/${configId}`);
    }
  };

  useEffect(() => {
    if (!isAuthReady) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const socket = new WebSocket(`${protocol}//${host}`);

    socket.onopen = () => {
      console.log('WebSocket Connected');
      setWs(socket);
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      
      // Only process messages for the current user session
      if (message.uid && user && message.uid !== user.uid) return;
      if (message.uid && !user && message.uid !== SESSION_ID) return;

      if (message.type === 'frame') {
        setScreenshot(message.data);
      } else if (message.type === 'progress') {
        if (message.current > currentVisit) {
          setLastCompletedVisit(currentVisit);
          setTimeout(() => setLastCompletedVisit(null), 5000);
        }
        setCurrentVisit(message.current);
        setTotalVisits(message.total);
      } else if (message.type === 'action') {
        setCurrentAction(message.action);
      } else if (message.type === 'log') {
        setLogs(prev => {
          const newLogs = [...prev, message.data];
          return newLogs.slice(-100);
        });
      } else if (message.type === 'request_decision' && message.requestId) {
        if (aiQuotaCooldown) {
          console.log("AI Quota cooldown active. Using fallback action.");
          socket.send(JSON.stringify({ 
            type: 'ai_decision', 
            requestId: message.requestId, 
            decision: { action: "SCROLL", x: null, y: null, reason: "Quota cooldown active: scrolling to maintain activity." }, 
            uid: user?.uid || SESSION_ID 
          }));
          return;
        }

        const getAIDecision = async (retryCount = 0): Promise<any> => {
          try {
            // Use user-provided keys if available, otherwise fallback to env key
            const envKey = process.env.GEMINI_API_KEY;
            const availableKeys = apiKeys.length > 0 ? apiKeys : (envKey ? [envKey] : []);
            
            if (availableKeys.length === 0) {
              throw new Error("No Gemini API key available. Please add one in the 'Gemini API Keys' box above.");
            }

            const currentKey = availableKeys[retryCount % availableKeys.length];
            const ai = new GoogleGenAI({ apiKey: currentKey });
            const prompt = `You are an expert human-like web interaction bot. Analyze this screenshot of a webpage.
            The screenshot dimensions are ${message.width}x${message.height}.
            Your goal is to simulate a real human user to generate high-quality, natural traffic.
            
            CURRENT MODE: ${message.trafficType === 'organic' ? 'Organic (Ad Traffic)' : 'Direct (Landing Page/Ad Link)'}
            CURRENT STATE: You have closed ${message.popupCloseCount || 0} pop-ups so far in this session.
            
            HUMAN-LIKE STRATEGY:
            1. **CRITICAL - AD & POPUP REMOVAL:** If you see ANY overlay, popup, or banner that blocks the page, prioritize closing it. 
               - **Look for the "X" icon, "Close", "Dismiss", or "Skip Ad" button.** 
               - **DO NOT click the middle of an ad to close it.** You must find the specific close button.
               - Look for fake buttons like "Download is ready", "Tap to proceed", "Start Download" that are clearly ads. Use "CLOSE_POPUP" on the "X" if available, otherwise use "CLOSE_POPUP" on the most likely close area.
               - This applies to ALL modes.
            2. **MODE-SPECIFIC BEHAVIOR:**
               - **If MODE is "Organic (Ad Traffic)":** You should primarily SCROLL, **INTERACT** with page elements (links, buttons, menus), and **FREQUENTLY** CLICK_AD. Be natural and selective.
               - **If MODE is "Direct (Landing Page/Ad Link)":** This is often a direct link to an ad or a landing page (e.g., Montage/MoneyTag). You SHOULD interact with the page naturally. You MAY click ads, buttons like "Proceed", "Continue", or "Accept" if they appear to be part of the user's intended path. Your goal is to look like a real interested visitor.
            3. **INTERACT:** Use this to click on interesting parts of the page, menu items, or internal links to look like a real browsing human.
            4. **FAST INTERACTION:** Act quickly. If you see a CAPTCHA, solve it.
            5. If there is a video, you may use "CLOSE_POPUP" to skip ads or "SCROLL" to browse.
            6. Spend some time "WAIT"ing or "SCROLL"ing to look natural, but prioritize clearing the screen of any obstructions first.
            7. **DISTANCE IDENTIFICATION:** Look for ads and elements across the entire page, not just the center. Identify targets even if they are far from the current mouse position.
            
            IMPORTANT: 
            - Be extremely precise with (x, y) coordinates.
            - **Look for the EXACT visual center of the "Skip Ad" button, "X" icon, or the "Close" text.**
            - If you see a Google AdSense "Vignette" (full screen ad), look for the "Close" or "X" at the top right or top left.
            - Return ONLY a JSON object.
            - Use the following format:
            {
              "action": "CLICK_AD" | "CLOSE_POPUP" | "SCROLL" | "WAIT" | "NAVIGATE_BACK" | "INTERACT",
              "x": number | null,
              "y": number | null,
              "reason": "string explaining your action based on the current mode (${message.trafficType})"
            }
            
            If action is SCROLL, WAIT, NAVIGATE_BACK, or if no specific coordinate is needed, x and y can be null.`;

            const allowedActions = ["CLICK_AD", "CLOSE_POPUP", "SCROLL", "WAIT", "NAVIGATE_BACK", "INTERACT"];

            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: [
                {
                  parts: [
                    { text: prompt },
                    { inlineData: { data: message.screenshot, mimeType: "image/jpeg" } }
                  ]
                }
              ],
              config: {
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    action: { type: Type.STRING, enum: allowedActions },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    reason: { type: Type.STRING }
                  },
                  required: ["action", "reason"]
                }
              }
            });

            const result = JSON.parse(response.text || "{}");

            socket.send(JSON.stringify({ 
              type: 'ai_decision', 
              requestId: message.requestId, 
              decision: result, 
              uid: user?.uid || SESSION_ID 
            }));
          } catch (err: any) {
            console.error("AI Error:", err);
            const errStr = JSON.stringify(err);
            const isQuotaError = 
              err.message?.toLowerCase().includes('429') || 
              err.message?.toLowerCase().includes('quota') ||
              errStr.toLowerCase().includes('429') ||
              errStr.toLowerCase().includes('quota');

            if (isQuotaError) {
              const envKey = process.env.GEMINI_API_KEY;
              const availableKeys = apiKeys.length > 0 ? apiKeys : (envKey ? [envKey] : []);
              const hasMoreKeys = availableKeys.length > retryCount + 1;

              if (hasMoreKeys) {
                // If we have more keys, try the next one immediately
                socket.send(JSON.stringify({ 
                  type: 'log', 
                  data: `[SYSTEM] Key #${retryCount + 1} quota exhausted. Rotating to Key #${retryCount + 2}...`, 
                  uid: user?.uid || SESSION_ID 
                }));
                return getAIDecision(retryCount + 1);
              } else {
                // No more keys left, enter cooldown
                setAiQuotaCooldown(true);
                socket.send(JSON.stringify({ 
                  type: 'log', 
                  data: `[SYSTEM] ALL API keys quota exhausted. Entering 5-minute auto-pilot mode. TIP: Add more Gemini API keys in the settings box to avoid this.`, 
                  uid: user?.uid || SESSION_ID 
                }));
                setTimeout(() => setAiQuotaCooldown(false), 300000); // 5 minute cooldown
                
                // Send fallback decision immediately
                return socket.send(JSON.stringify({ 
                  type: 'ai_decision', 
                  requestId: message.requestId, 
                  decision: { action: "SCROLL", x: null, y: null, reason: "AI Quota exhausted: using auto-pilot scroll." }, 
                  uid: user?.uid || SESSION_ID 
                }));
              }
            }
            
            // For non-quota errors, retry up to 2 times
            const maxRetries = 2;
            if (retryCount < maxRetries) {
              console.log(`Retrying AI decision (${retryCount + 1})...`);
              return getAIDecision(retryCount + 1);
            }
            
            // Final fallback if all retries fail (non-quota errors)
            socket.send(JSON.stringify({ 
              type: 'ai_decision', 
              requestId: message.requestId, 
              decision: { action: "SCROLL", x: null, y: null, reason: "AI failed after retries: scrolling as fallback." }, 
              uid: user?.uid || SESSION_ID 
            }));
          }
        };

        getAIDecision();
      }
    };

    socket.onclose = () => {
      console.log('WebSocket Disconnected');
      setWs(null);
    };

    return () => socket.close();
  }, []);

  const fetchStatus = async () => {
    try {
      const uid = user?.uid || SESSION_ID;
      const res = await fetch(`/api/logs?uid=${uid}`);
      if (res.ok) {
        const data = await res.json();
        setIsRunning(data.isRunning);
        setProxyCount(data.proxyCount || 0);
      }
    } catch (err) {}
  };

  useEffect(() => {
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  const handleProxyUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      const proxies = text.split('\n').map(p => p.trim()).filter(p => p.length > 0);
      
      try {
        const uid = user?.uid || SESSION_ID;
        const res = await fetch('/api/proxies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proxies, uid })
        });
        if (res.ok) {
          const data = await res.json();
          setProxyCount(data.count);
        }
      } catch (err) {
        console.error('Failed to upload proxies:', err);
      }
    };
    reader.readAsText(file);
  };

  const handleStart = async () => {
    if (!url) {
      setError('Please enter a target URL');
      return;
    }
    
    setError(null);
    setCurrentVisit(0);
    setTotalVisits(visits);
    try {
      const uid = user?.uid || SESSION_ID;
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          visits,
          minPerVisit,
          headless,
          useProxies,
          keywords: enableKeywords ? keywords.split(',').map(k => k.trim()) : [],
          trafficType,
          organicUrls: trafficType === 'organic' ? organicUrls.filter(u => u.trim() !== '') : [],
          smartAI,
          uid
        })
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start bot');
      }
      
      setIsRunning(true);
      setLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start bot');
    }
  };

  const handleStop = async () => {
    try {
      const uid = user?.uid || SESSION_ID;
      await fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid })
      });
      setIsRunning(false);
      setCurrentAction(null);
      setCurrentVisit(0);
      setTotalVisits(0);
      setScreenshot(null);
      setLastCompletedVisit(null);
      setAiQuotaCooldown(false);
      setLogs(prev => [...prev, "[SYSTEM] Engine stopped manually. Progress reset."].slice(-100));
    } catch (err) {
      console.error('Failed to stop bot:', err);
    }
  };

  const clearLogs = async () => {
    try {
      const uid = user?.uid || SESSION_ID;
    await fetch(`/api/logs?uid=${uid}`, { method: 'DELETE' });
      setLogs([]);
    } catch (err) {
      console.error('Failed to clear logs:', err);
    }
  };

  const addApiKey = () => {
    if (!newApiKey.trim()) return;
    if (apiKeys.includes(newApiKey.trim())) {
      setNewApiKey('');
      return;
    }
    const updatedKeys = [...apiKeys, newApiKey.trim()];
    setApiKeys(updatedKeys);
    localStorage.setItem('bot_api_keys', JSON.stringify(updatedKeys));
    setNewApiKey('');
  };

  const removeApiKey = (keyToRemove: string) => {
    const updatedKeys = apiKeys.filter(k => k !== keyToRemove);
    setApiKeys(updatedKeys);
    localStorage.setItem('bot_api_keys', JSON.stringify(updatedKeys));
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-bold text-lg tracking-tight text-white">Bot Engine <span className="text-indigo-500">v2.0</span></h1>
          </div>
          
          <div className="flex items-center gap-4">
            {isRunning && totalVisits > 0 && (
              <div className="hidden md:flex items-center gap-3 px-4 py-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-full">
                <div className="flex flex-col">
                  <div className="flex items-center justify-between gap-8">
                    <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">Progress</span>
                    <span className="text-[10px] font-bold text-indigo-400">{Math.round((currentVisit / totalVisits) * 100)}%</span>
                  </div>
                  <div className="w-32 h-1 bg-slate-800 rounded-full overflow-hidden mt-1">
                    <motion.div 
                      className="h-full bg-indigo-500"
                      initial={{ width: 0 }}
                      animate={{ width: `${(currentVisit / totalVisits) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="w-px h-6 bg-slate-800 mx-1" />
                <div className="text-center">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Visits</div>
                  <div className="text-xs font-bold text-white">{currentVisit} / {totalVisits}</div>
                </div>
              </div>
            )}
            
            <div className="hidden sm:flex items-center gap-4 px-4 py-1.5 bg-slate-800/50 rounded-full border border-slate-700">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
                <span className="text-xs font-medium text-slate-300">{isRunning ? 'Engine Running' : 'Engine Idle'}</span>
              </div>
              <div className="w-px h-3 bg-slate-700" />
              <div className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs font-medium text-slate-300">{proxyCount} Proxies</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Configuration */}
        <div className="lg:col-span-4 space-y-6">
            {/* API Key Management Card */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-indigo-400" />
                  <h3 className="font-bold text-sm text-white uppercase tracking-wider">Gemini API Keys</h3>
                </div>
                {apiKeys.length > 0 && (
                  <span className="text-[10px] font-bold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/20">
                    {apiKeys.length} Active
                  </span>
                )}
              </div>
              
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input 
                    type="password"
                    value={newApiKey}
                    onChange={(e) => setNewApiKey(e.target.value)}
                    placeholder="Paste API Key here..."
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                  <button 
                    onClick={() => {
                      if (newApiKey.trim()) {
                        const updated = [...apiKeys, newApiKey.trim()];
                        setApiKeys(updated);
                        saveApiKeyToFirestore(updated);
                        setNewApiKey('');
                      }
                    }}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-lg text-xs font-bold transition-colors flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </button>
                </div>
                
                <div className="max-h-32 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                  {apiKeys.length === 0 ? (
                    <div className="text-[10px] text-slate-500 italic text-center py-2">
                      No custom keys added. Using system default.
                    </div>
                  ) : (
                    apiKeys.map((key, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-slate-950 border border-slate-800/50 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2 overflow-hidden">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          <span className="text-[10px] text-slate-400 font-mono truncate">
                            {key.substring(0, 8)}...{key.substring(key.length - 4)}
                          </span>
                        </div>
                        <button 
                          onClick={() => {
                            const updated = apiKeys.filter(k => k !== key);
                            setApiKeys(updated);
                            saveApiKeyToFirestore(updated);
                          }}
                          className="text-slate-500 hover:text-rose-500 transition-colors p-1"
                          title="Remove Key"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <p className="text-[9px] text-slate-500 leading-relaxed">
                  Add multiple keys to rotate automatically when quota is exceeded. Keys are stored securely in Firestore.
                </p>
              </div>
            </div>

          {/* Progress Stats Card (Visible when running) */}
          <AnimatePresence>
            {isRunning && (
              <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="bg-slate-900/50 border border-slate-800 rounded-2xl p-5 shadow-xl mb-6"
              >
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-emerald-500" />
                    <h3 className="font-bold text-sm text-white uppercase tracking-widest">
                      Engine Progress
                    </h3>
                  </div>
                  <span className="text-[10px] font-black text-slate-950 bg-emerald-500 px-2 py-1 rounded uppercase tracking-tighter">
                    {totalVisits > 0 ? Math.round((currentVisit / totalVisits) * 100) : 0}%
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-950/40 rounded-xl p-4 border border-slate-800/50 relative overflow-hidden">
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Completed</div>
                    <div className="text-3xl font-black text-white">{currentVisit}</div>
                    <AnimatePresence>
                      {lastCompletedVisit !== null && (
                        <motion.div 
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          className="absolute inset-0 bg-emerald-500 flex items-center justify-center text-[10px] font-bold text-white uppercase tracking-widest"
                        >
                          Visit #{lastCompletedVisit + 1} Done!
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  <div className="bg-slate-950/40 rounded-xl p-4 border border-slate-800/50">
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Remaining</div>
                    <div className="text-3xl font-black text-slate-400">{totalVisits - currentVisit}</div>
                  </div>
                </div>

                <div className="mt-6 w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-emerald-500/80 shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                    initial={{ width: 0 }}
                    animate={{ width: `${totalVisits > 0 ? (currentVisit / totalVisits) * 100 : 0}%` }}
                    transition={{ type: "spring", stiffness: 50 }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main Config Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-indigo-400" />
                <h2 className="font-bold text-sm text-white uppercase tracking-widest">Configuration</h2>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={() => setShowConfigModal(true)}
                  className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
                  title="Saved Configs"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => {
                    const name = window.prompt("Enter a name for this configuration:");
                    if (name) saveConfig(name);
                  }}
                  className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
                  title="Save Current Config"
                >
                  <Save className="w-4 h-4" />
                </button>
              </div>
            </div>
            
            <div className="p-5 space-y-6">
              {/* URL Input */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Target URL</label>
                <div className="relative group">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-indigo-500 transition-colors" />
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com"
                    disabled={isRunning}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all disabled:opacity-50"
                  />
                </div>
              </div>

              {/* Traffic Control */}
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Traffic Mode</label>
                <div className="grid grid-cols-2 gap-2 p-1 bg-slate-950 rounded-xl border border-slate-800">
                  <button
                    onClick={() => setTrafficType('direct')}
                    disabled={isRunning}
                    className={`py-2.5 px-4 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                      trafficType === 'direct' 
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Direct Link (Ad/Landing)
                  </button>
                  <button
                    onClick={() => setTrafficType('organic')}
                    disabled={isRunning}
                    className={`py-2.5 px-4 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                      trafficType === 'organic' 
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Organic (Search Traffic)
                  </button>
                </div>

                {trafficType === 'organic' && (
                  <div className="space-y-4 pt-2 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Search Keywords</label>
                        <input
                          type="checkbox"
                          checked={enableKeywords}
                          onChange={(e) => setEnableKeywords(e.target.checked)}
                          disabled={isRunning}
                          className="w-3.5 h-3.5 rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-indigo-500/20"
                        />
                      </div>
                      {enableKeywords && (
                        <div className="space-y-2 animate-in zoom-in-95 duration-200">
                          <input
                            type="text"
                            value={keywords}
                            onChange={(e) => setKeywords(e.target.value)}
                            placeholder="keyword1, keyword2, keyword3"
                            disabled={isRunning}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg py-2 px-3 text-xs focus:outline-none focus:border-indigo-500 transition-all"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Visits & Min Per Visit */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">VISITS</label>
                  <input
                    type="number"
                    value={visits}
                    onChange={(e) => setVisits(parseInt(e.target.value) || 0)}
                    disabled={isRunning}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all disabled:opacity-50"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">MIN PER VISIT</label>
                  <input
                    type="number"
                    value={minPerVisit}
                    onChange={(e) => setMinPerVisit(parseInt(e.target.value) || 0)}
                    disabled={isRunning}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all disabled:opacity-50"
                  />
                </div>
              </div>

              {/* Toggles */}
              <div className="space-y-3 pt-2">
                <div 
                  onClick={() => !isRunning && setSmartAI(!smartAI)}
                  className={`flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer ${
                    smartAI ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-slate-950 border-slate-800 opacity-60'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Activity className={`w-4 h-4 ${smartAI ? 'text-indigo-400' : 'text-slate-500'}`} />
                    <span className={`text-xs font-bold uppercase tracking-wider ${smartAI ? 'text-white' : 'text-slate-500'}`}>Smart AI Behavior</span>
                  </div>
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${smartAI ? 'bg-indigo-600 border-indigo-500' : 'bg-slate-900 border-slate-700'}`}>
                    {smartAI && <CheckCircle2 className="w-3 h-3 text-white" />}
                  </div>
                </div>

                <div 
                  onClick={() => !isRunning && setHeadless(!headless)}
                  className={`flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer ${
                    headless ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-slate-950 border-slate-800 opacity-60'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Terminal className={`w-4 h-4 ${headless ? 'text-indigo-400' : 'text-slate-500'}`} />
                    <span className={`text-xs font-bold uppercase tracking-wider ${headless ? 'text-white' : 'text-slate-500'}`}>Headless Mode</span>
                  </div>
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${headless ? 'bg-indigo-600 border-indigo-500' : 'bg-slate-900 border-slate-700'}`}>
                    {headless && <CheckCircle2 className="w-3 h-3 text-white" />}
                  </div>
                </div>

                <div className="space-y-3">
                  <div 
                    onClick={() => !isRunning && setUseProxies(!useProxies)}
                    className={`flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer ${
                      useProxies ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-slate-950 border-slate-800 opacity-60'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Globe className={`w-4 h-4 ${useProxies ? 'text-indigo-400' : 'text-slate-500'}`} />
                      <span className={`text-xs font-bold uppercase tracking-wider ${useProxies ? 'text-white' : 'text-slate-500'}`}>Proxy Management</span>
                    </div>
                    <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${useProxies ? 'bg-indigo-600 border-indigo-500' : 'bg-slate-900 border-slate-700'}`}>
                      {useProxies && <CheckCircle2 className="w-3 h-3 text-white" />}
                    </div>
                  </div>

                  {useProxies && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-3 p-4 bg-slate-950 border border-slate-800 rounded-xl"
                    >
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full bg-slate-900 hover:bg-slate-800 border border-slate-700 text-white font-bold py-3 px-4 rounded-lg text-[10px] uppercase tracking-widest transition-all"
                      >
                        Upload Proxy List (.txt)
                      </button>
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleProxyUpload}
                        accept=".txt"
                        className="hidden"
                      />
                      <p className="text-[9px] text-slate-500 text-center uppercase tracking-widest">Format: IP:PORT:USER:PASS or IP:PORT</p>
                    </motion.div>
                  )}
                </div>
              </div>

              {/* Action Button */}
              <div className="pt-4">
                {isRunning ? (
                  <button
                    onClick={handleStop}
                    className="w-full bg-rose-600 hover:bg-rose-700 text-white font-black py-4 px-6 rounded-xl flex items-center justify-center gap-3 transition-all shadow-lg shadow-rose-600/20 uppercase tracking-widest"
                  >
                    <Square className="w-5 h-5 fill-white" />
                    Stop Engine
                  </button>
                ) : (
                  <button
                    onClick={handleStart}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-4 px-6 rounded-xl flex items-center justify-center gap-3 transition-all shadow-lg shadow-indigo-600/20 uppercase tracking-widest"
                  >
                    <Play className="w-5 h-5 fill-white" />
                    Start Engine
                  </button>
                )}
                {error && (
                  <div className="mt-3 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center gap-2 text-rose-400 text-xs">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Live Feed & Logs */}
        <div className="lg:col-span-8 space-y-6">
          {/* Live Feed Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                <h2 className="font-bold text-sm text-white uppercase tracking-widest">Live Browser Feed</h2>
              </div>
              <div className="flex items-center gap-3">
                {aiQuotaCooldown && (
                  <div className="flex items-center gap-1.5 px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] font-bold text-amber-500 uppercase tracking-wider animate-pulse">
                    AI Cooldown
                  </div>
                )}
                {isRunning && (
                  <div className="flex items-center gap-2">
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                    <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Live</span>
                  </div>
                )}
              </div>
            </div>
            
            <div className="aspect-video bg-slate-950 relative group">
              {screenshot ? (
                <img 
                  src={`data:image/jpeg;base64,${screenshot}`} 
                  alt="Live Feed" 
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                  {isRunning ? (
                    <>
                      <Loader2 className="w-10 h-10 animate-spin mb-4 text-indigo-500/50" />
                      <p className="text-sm font-medium animate-pulse">Waiting for browser stream...</p>
                    </>
                  ) : (
                    <>
                      <Globe className="w-12 h-12 mb-4 opacity-20" />
                      <p className="text-sm font-medium opacity-50">Engine Offline</p>
                    </>
                  )}
                </div>
              )}
              
              {/* Overlay Info */}
              <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none">
                <div className="flex flex-col gap-2">
                  {currentAction && (
                    <motion.div 
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="px-3 py-1.5 bg-indigo-600/90 backdrop-blur-md border border-indigo-400/30 rounded-lg text-[10px] font-bold text-white uppercase tracking-widest shadow-lg"
                    >
                      Action: {currentAction}
                    </motion.div>
                  )}
                  <div className="px-3 py-1.5 bg-slate-900/80 backdrop-blur-md border border-slate-700 rounded-lg text-[10px] font-mono text-slate-300">
                    {url || 'No Target'}
                  </div>
                </div>
                <div className="px-3 py-1.5 bg-slate-900/80 backdrop-blur-md border border-slate-700 rounded-lg text-[10px] font-mono text-slate-300">
                  1920x1080
                </div>
              </div>
            </div>
          </div>

          {/* System Console Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col h-[400px]">
            <div className="p-4 border-b border-slate-800 bg-slate-800/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <h2 className="font-bold text-sm text-white uppercase tracking-widest">System Console</h2>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={clearLogs}
                  className="text-[10px] font-black text-slate-500 hover:text-slate-300 uppercase tracking-widest transition-colors"
                >
                  CLEAR LOGS
                </button>
              </div>
            </div>
            
            <div 
              ref={logsContainerRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1.5 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent"
            >
              <AnimatePresence initial={false}>
                {logs.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-slate-600 italic">
                    No system logs to display
                  </div>
                ) : (
                  logs.map((log, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex gap-3 group"
                    >
                      <span className="text-slate-600 shrink-0 select-none">{i + 1}</span>
                      <span className={`break-all ${
                        log.includes('Error') ? 'text-rose-400' : 
                        log.includes('Success') || log.includes('Verified') ? 'text-emerald-400' : 
                        log.includes('AI') ? 'text-indigo-400' :
                        'text-slate-300'
                      }`}>
                        {log}
                      </span>
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
            
            <div className="p-3 border-t border-slate-800 bg-slate-950 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                  <span className="text-[10px] text-slate-500 font-medium uppercase tracking-widest">System Ready</span>
                </div>
              </div>
              <div className="text-[10px] text-slate-600 font-mono">
                UTF-8 | Node.js | Puppeteer
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-4 py-8 border-t border-slate-900">
        <div className="flex flex-col md:row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-500 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500" />
            <span>Stealth Mode Active</span>
            <span className="mx-2 text-slate-800">|</span>
            <span>Fingerprint Protection Enabled</span>
          </div>
          <p className="text-slate-600 text-[10px] font-medium uppercase tracking-widest">
            © 2026 Bot Engine Pro • Advanced Traffic Generation
          </p>
        </div>
      </footer>

      {/* Config Modal */}
      <AnimatePresence>
        {showConfigModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-lg font-bold text-white">Saved Configurations</h3>
                <button 
                  onClick={() => setShowConfigModal(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <Square className="w-5 h-5 rotate-45" />
                </button>
              </div>
              <div className="p-6 max-h-[60vh] overflow-y-auto space-y-3 custom-scrollbar">
                {savedConfigs.length === 0 ? (
                  <div className="text-center py-8 text-slate-500">
                    <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No saved configurations found.</p>
                  </div>
                ) : (
                  savedConfigs.map((config) => (
                    <div 
                      key={config.id}
                      className="group bg-slate-800/50 border border-slate-700 rounded-xl p-4 flex items-center justify-between hover:border-indigo-500/50 transition-all"
                    >
                      <div className="flex-1 cursor-pointer" onClick={() => loadConfig(config)}>
                        <h4 className="font-bold text-white group-hover:text-indigo-400 transition-colors">{config.name}</h4>
                        <p className="text-xs text-slate-400 truncate max-w-[250px]">{config.url}</p>
                        <div className="flex gap-2 mt-2">
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 rounded text-slate-300 uppercase">{config.trafficType}</span>
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-700 rounded text-slate-300">{config.visits} visits</span>
                        </div>
                      </div>
                      <button 
                        onClick={() => {
                          if (window.confirm("Delete this configuration?")) {
                            deleteConfig(config.id);
                          }
                        }}
                        className="p-2 text-slate-500 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

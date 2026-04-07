import express from 'express';
console.log('Server script starting...');
import { createServer as createViteServer } from 'vite';
import path from 'path';
import cors from 'cors';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

puppeteer.use(StealthPlugin());

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // WebSocket connection handling
  let connectedClients: WebSocket[] = [];
  let pendingDecisions: Map<string, (decision: any) => void> = new Map();

  wss.on('connection', (ws) => {
    connectedClients.push(ws);
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ai_decision' && message.requestId) {
          const resolve = pendingDecisions.get(message.requestId);
          if (resolve) {
            resolve(message.decision);
            pendingDecisions.delete(message.requestId);
          }
        }
      } catch (e) {
        console.error('Error parsing WS message:', e);
      }
    });

    ws.on('close', () => {
      connectedClients = connectedClients.filter(c => c !== ws);
    });
  });

  const requestAIDecision = (uid: string, screenshot: string, width: number, height: number, popupCloseCount: number, trafficType: string): Promise<any> => {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).substring(7);
      pendingDecisions.set(requestId, resolve);
      
      const message = JSON.stringify({ type: 'request_decision', requestId, screenshot, uid, width, height, popupCloseCount, trafficType });
      
      // Send to the first available client (usually the dashboard)
      const client = connectedClients.find(c => c.readyState === WebSocket.OPEN);
      if (client) {
        client.send(message);
      } else {
        addLog(uid, "Warning: No active dashboard connected to process AI decision.");
        resolve(null);
      }

      // Timeout after 60 seconds (increased from 30s to avoid premature timeouts)
      setTimeout(() => {
        if (pendingDecisions.has(requestId)) {
          pendingDecisions.delete(requestId);
          resolve(null);
        }
      }, 60000);
    });
  };

  // Multi-user session management
  const userSessions: Map<string, {
    browser: Browser | null;
    isRunning: boolean;
    logs: string[];
    proxyList: string[];
    currentScreenshot: string | null;
    popupCloseCount: number;
  }> = new Map();

  const getOrCreateSession = (uid: string) => {
    if (!userSessions.has(uid)) {
      userSessions.set(uid, {
        browser: null,
        isRunning: false,
        logs: [],
        proxyList: [],
        currentScreenshot: null,
        popupCloseCount: 0
      });
    }
    return userSessions.get(uid)!;
  };

  const addLog = (uid: string, msg: string) => {
    const session = getOrCreateSession(uid);
    const timestamp = new Date().toLocaleTimeString();
    const formattedMsg = `[${timestamp}] ${msg}`;
    session.logs.push(formattedMsg);
    if (session.logs.length > 100) session.logs.shift();
    console.log(`[Bot ${uid}] ${msg}`);
    
    // Broadcast to the specific user's dashboard
    const message = JSON.stringify({ type: 'log', data: formattedMsg, uid });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  const broadcastFrame = (uid: string, base64Frame: string, width: number, height: number) => {
    const session = getOrCreateSession(uid);
    session.currentScreenshot = base64Frame;
    const message = JSON.stringify({ type: 'frame', data: base64Frame, uid, width, height });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  const broadcastAction = (uid: string, action: string) => {
    const message = JSON.stringify({ type: 'action', action, uid });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  const broadcastProgress = (uid: string, current: number, total: number) => {
    const message = JSON.stringify({ type: 'progress', current, total, uid });
    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };

  app.get('/api/logs', (req, res) => {
    const uid = req.query.uid as string;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const session = getOrCreateSession(uid);
    res.json({ logs: session.logs, isRunning: session.isRunning, proxyCount: session.proxyList.length, screenshot: session.currentScreenshot });
  });

  app.delete('/api/logs', (req, res) => {
    const uid = req.query.uid as string;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const session = getOrCreateSession(uid);
    session.logs = [];
    res.json({ message: 'Logs cleared' });
  });

  app.post('/api/proxies', (req, res) => {
    const { proxies, uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    if (Array.isArray(proxies)) {
      const session = getOrCreateSession(uid);
      session.proxyList = proxies.filter(p => p.trim().length > 0);
      addLog(uid, `Proxy pool updated: ${session.proxyList.length} proxies are ready.`);
      res.json({ message: 'Proxies updated', count: session.proxyList.length });
    } else {
      res.status(400).json({ error: 'Invalid proxy list' });
    }
  });

  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  ];

  const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1280, height: 720 },
  ];

  app.post('/api/start', async (req, res) => {
    const {
      url,
      visits = 1,
      minPerVisit = 1,
      headless = true,
      useProxies = false,
      keywords = [],
      trafficType = 'direct',
      organicUrls = [],
      smartAI = true,
      uid
    } = req.body;

    if (!uid) return res.status(400).json({ error: 'UID is required' });
    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    const session = getOrCreateSession(uid);
    if (session.isRunning) return res.status(400).json({ error: 'Bot is already running for this user' });
    if (useProxies && session.proxyList.length === 0) return res.status(400).json({ error: 'No proxies loaded.' });

    session.isRunning = true;
    session.logs = [];
    session.popupCloseCount = 0;
    addLog(uid, `Starting ${trafficType.toUpperCase()} traffic bot for: ${url}`);
    addLog(uid, `Config: ${visits} visits, min ${minPerVisit}m per visit, headless: ${headless}`);

    (async () => {
      try {
        const waitTime = minPerVisit * 60000;
        for (let i = 0; i < visits; i++) {
          if (!session.isRunning) break;
          broadcastProgress(uid, i + 1, visits);
          addLog(uid, `Visit #${i + 1}/${visits} starting (Simulating new device)...`);

          const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-position=0,0',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
          ];

          const randomViewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
          const randomUA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
          
          addLog(uid, `Visit #${i + 1} - Device: ${randomViewport.width}x${randomViewport.height}, UA: ...${randomUA.slice(-20)}`);

          let currentProxy = '';
          let proxyAuth: any = null;

          if (useProxies && session.proxyList.length > 0) {
            const rawProxy = session.proxyList[i % session.proxyList.length];
            if (rawProxy.includes('@')) {
              const parts = rawProxy.split('@');
              const authParts = parts[0].split(':');
              currentProxy = parts[1];
              proxyAuth = { username: authParts[0], password: authParts[1] };
            } else {
              const parts = rawProxy.split(':');
              if (parts.length === 4) {
                currentProxy = `${parts[0]}:${parts[1]}`;
                proxyAuth = { username: parts[2], password: parts[3] };
              } else {
                currentProxy = rawProxy;
              }
            }
            launchArgs.push(`--proxy-server=${currentProxy}`);
            addLog(uid, `Using Proxy: ${currentProxy}`);
          }

          try {
            addLog(uid, "Initializing browser engine...");
            session.browser = await puppeteer.launch({
              headless: headless === true || headless === 'true',
              args: [
                ...launchArgs,
                `--window-size=${randomViewport.width},${randomViewport.height}`,
                '--disable-web-security',
                '--allow-running-insecure-content',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--mute-audio',
              ],
            }) as any;
          } catch (launchErr: any) {
            addLog(uid, `Failed to launch browser: ${launchErr.message}. Retrying...`);
            await new Promise(r => setTimeout(r, 5000));
            i--; // Retry this visit
            continue;
          }

          // Use a fresh incognito context for every visit to ensure no cookies/cache persist
          const context = await session.browser!.createBrowserContext();
          const page = await context.newPage();
          
          // Clear any potential leftover data (though incognito should handle it)
          const cdpClient = await page.target().createCDPSession();
          await cdpClient.send('Network.clearBrowserCookies');
          await cdpClient.send('Network.clearBrowserCache');
          
          if (proxyAuth) await page.authenticate(proxyAuth);

          const captureAndBroadcast = async (targetPage = page) => {
            if (!session.isRunning || !targetPage || targetPage.isClosed()) return;
            try {
              const base64 = await targetPage.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 });
              broadcastFrame(uid, base64, randomViewport.width, randomViewport.height);
              return base64;
            } catch (e) {
              return null;
            }
          };

          await page.setUserAgent(randomUA);
          await page.setViewport(randomViewport);

          let urlSequence = [url];
          if (trafficType === 'organic') {
            if (keywords && keywords.length > 0) {
              const randomKeyword = keywords[Math.floor(Math.random() * keywords.length)];
              addLog(uid, `Organic Search Mode: Searching for "${randomKeyword}" on Google...`);
              await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });
              await page.type('textarea[name="q"]', randomKeyword, { delay: 100 });
              await page.keyboard.press('Enter');
              await page.waitForNavigation({ waitUntil: 'networkidle2' });
              
              addLog(uid, `Searching for target URL: ${url} in results...`);
              const found = await page.evaluate((targetUrl) => {
                const links = Array.from(document.querySelectorAll('a'));
                const targetLink = links.find(l => l.href.includes(targetUrl));
                if (targetLink) {
                  targetLink.scrollIntoView();
                  return true;
                }
                return false;
              }, url);

              if (found) {
                addLog(uid, "Target URL found in search results. Clicking...");
                await Promise.all([
                  page.waitForNavigation({ waitUntil: 'networkidle2' }),
                  page.evaluate((targetUrl) => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const targetLink = links.find(l => l.href.includes(targetUrl));
                    if (targetLink) targetLink.click();
                  }, url)
                ]);
              } else {
                addLog(uid, "Target URL not found on first page of search results. Navigating directly.");
                await page.goto(url, { waitUntil: 'networkidle2' });
              }
            } else {
              urlSequence = [url, ...organicUrls].sort(() => Math.random() - 0.5);
            }
          }

          for (let uIdx = 0; uIdx < urlSequence.length; uIdx++) {
            if (!session.isRunning) break;
            const currentTargetUrl = urlSequence[uIdx];
            const isMainUrl = currentTargetUrl === url;
            const stepStartTime = Date.now();

            addLog(uid, `Navigating to: ${currentTargetUrl}`);
            await page.goto(currentTargetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await captureAndBroadcast(); // Send first frame immediately after load
            
            // Add a random initial delay to look more human
            const initialDelay = 3000 + Math.random() * 5000;
            await new Promise(r => setTimeout(r, initialDelay));
            
            // Special handling for YouTube to ensure player is ready
            if (currentTargetUrl.includes('youtube.com') || currentTargetUrl.includes('youtu.be')) {
              addLog(uid, "YouTube detected. Waiting for player...");
              await new Promise(r => setTimeout(r, 5000));
              // Try to auto-click play button if AI doesn't
              try {
                await page.click('button.ytp-large-play-button').catch(() => {});
              } catch (e) {}
            }
            
            await captureAndBroadcast(); // Immediate update after load

            const stepWaitTime = trafficType === 'organic' ? waitTime / urlSequence.length : waitTime;
            const cycleDuration = Math.min(600000, stepWaitTime);

            const autoCloseAds = async () => {
              if (!session.isRunning || !page || page.isClosed()) return false;
              try {
                return await page.evaluate((mode) => {
                  let closedCount = 0;
                  // Common ad selectors (X buttons, close text, etc.)
                  const selectors = [
                    'button[aria-label="Close"]', 'button[aria-label="dismiss"]',
                    'div[aria-label="Close"]', 'span[aria-label="Close"]',
                    '.close-button', '.close-btn', '.dismiss-button',
                    '#dismiss-button', '.skip-ad', '.ytp-ad-skip-button',
                    '.close-icon', '.close_icon', '.btn-close', '.ad-close',
                    '[id*="close"]', '[class*="close"]', '[id*="dismiss"]',
                    '[class*="dismiss"]', '[id*="skip"]', '[class*="skip"]',
                    'svg[class*="close"]', 'path[d*="M19 6.41"]',
                    '#close-button', '.close-wrapper', '.close-link',
                    '.ad-close-button', '.ad-dismiss', '.ad-skip',
                    '.ez-close-button', '.ez-dismiss', '.ez-skip',
                    '.sp-close-button', '.sp-dismiss', '.sp-skip',
                    '.qc-cmp2-close-icon', '.qc-cmp2-dismiss-button'
                  ];

                  // Look for elements that look like close buttons
                  const elements = document.querySelectorAll(selectors.join(','));
                  elements.forEach((el) => {
                    const htmlEl = el as HTMLElement;
                    const rect = htmlEl.getBoundingClientRect();
                    // Only click visible, small buttons (likely close buttons)
                    if (rect.width > 0 && rect.height > 0 && rect.width < 150 && rect.height < 150) {
                      htmlEl.click();
                      closedCount++;
                    }
                  });

                  // Also look for full-screen overlays and hide them
                  const overlays = Array.from(document.querySelectorAll('div, section, iframe, ins')).filter(el => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    const isFixed = style.position === 'fixed' || style.position === 'absolute';
                    const isLarge = rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5;
                    const isHighZ = style.zIndex && parseInt(style.zIndex) > 50;
                    
                    // Specific check for AdSense vignettes and other common ad iframes
                    const isAdSenseVignette = el.id?.includes('aswift') || el.className?.includes('adsbygoogle') || el.tagName === 'INS';
                    const isAdIframe = el.tagName === 'IFRAME' && (el.id?.includes('google_ads') || el.className?.includes('ad-iframe'));
                    
                    // Only hide blocking overlays that are clearly NOT the main content
                    // If it's a direct link, the "ad" might be the main content, so we are careful
                    return (isFixed && isLarge && isHighZ && style.backgroundColor !== 'transparent');
                  });

                  overlays.forEach(overlay => {
                    const htmlEl = overlay as HTMLElement;
                    htmlEl.style.display = 'none';
                    htmlEl.style.visibility = 'hidden';
                    htmlEl.style.opacity = '0';
                    htmlEl.style.pointerEvents = 'none';
                    closedCount++;
                  });

                  // We no longer hide ad containers in any mode to ensure compatibility with Direct Links (Montage, etc.)
                  // The AI will decide whether to click them or not.

                  return closedCount > 0;
                }, trafficType);
              } catch (e) {
                return false;
              }
            };

            let aiCycleCounter = 0;
            const runCycle = async () => {
              if (!session.isRunning || !page || page.isClosed()) return;
              try {
                // Always try automatic ad closing first to save AI credits
                const autoClosed = await autoCloseAds();
                if (autoClosed) {
                  addLog(uid, "Auto-Closer: Handled overlays/ads automatically.");
                  await captureAndBroadcast();
                  // If we auto-closed something, wait a bit before doing anything else
                  await new Promise(r => setTimeout(r, 2000));
                }

                aiCycleCounter++;
                // Call AI every 8 cycles instead of 5 to further save quota
                // Also skip AI if we just auto-closed something to be safe
                const isAiCycle = smartAI && (aiCycleCounter % 8 === 1) && !autoClosed;
                
                if (isAiCycle) {
                  const screenshot = await captureAndBroadcast();
                  if (screenshot) {
                    const decision = await requestAIDecision(uid, screenshot, randomViewport.width, randomViewport.height, session.popupCloseCount, trafficType);
                    if (decision) {
                      addLog(uid, `AI Decision: ${decision.action} - ${decision.reason}`);
                      broadcastAction(uid, decision.action);
                      
                      if (decision.action === 'CLICK_AD' || decision.action === 'CLOSE_POPUP' || decision.action === 'INTERACT') {
                        if (decision.x !== null && decision.y !== null && decision.x !== undefined && decision.y !== undefined) {
                          // Store current URL to detect same-tab navigation
                          const startUrl = page.url();

                          // Scroll element into view first for better reliability
                          await page.evaluate((x, y) => {
                            const el = document.elementFromPoint(x, y);
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }, decision.x, decision.y).catch(() => {});
                          await new Promise(r => setTimeout(r, 1000));

                          // Re-capture coordinates after scroll
                          await captureAndBroadcast();
                          
                          // Add jitter and mouse movement
                          const jitterX = decision.x + (Math.random() * 10 - 5);
                          const jitterY = decision.y + (Math.random() * 10 - 5);
                          
                          if (session.browser) {
                            await page.bringToFront().catch(() => {});
                            await page.evaluate(() => window.focus()).catch(() => {});
                          }
                          
                          // Move mouse from a "distance" to the target
                          const startX = Math.random() * randomViewport.width;
                          const startY = Math.random() * randomViewport.height;
                          await page.mouse.move(startX, startY);
                          await page.mouse.move(jitterX, jitterY, { steps: 15 });
                          await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                          
                          let resolved = false;
                          const newPagePromise = new Promise<Page | null>(resolve => {
                            const timeout = setTimeout(() => {
                              if (!resolved) {
                                resolved = true;
                                if (session.browser) session.browser.off('targetcreated', listener);
                                resolve(null);
                              }
                            }, 15000);

                            const listener = (target: any) => {
                              if (target.type() === 'page' && !resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                if (session.browser) session.browser.off('targetcreated', listener);
                                resolve(target.page());
                              }
                            };
                            if (session.browser) session.browser.on('targetcreated', listener);
                            else resolve(null);
                          });

                          // Human-like click
                          await page.mouse.down();
                          await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
                          await page.mouse.up();

                          // Wait for navigation or new tab
                          await new Promise(r => setTimeout(r, 5000));
                          
                          let openedPage = await newPagePromise;
                          let currentUrl = page.url();
                          let navigatedInSameTab = currentUrl !== startUrl;

                          // If no navigation detected yet, try a short wait for navigation
                          if (!openedPage && !navigatedInSameTab) {
                            await page.waitForNavigation({ timeout: 2000, waitUntil: 'domcontentloaded' }).catch(() => {});
                            currentUrl = page.url();
                            navigatedInSameTab = currentUrl !== startUrl;
                          }

                          if (!openedPage && !navigatedInSameTab && (decision.action === 'CLICK_AD' || decision.action === 'INTERACT')) {
                            addLog(uid, "Navigation not detected. Trying robust JS click...");
                            await page.evaluate((x, y) => {
                              const el = document.elementFromPoint(x, y) as HTMLElement;
                              if (el) {
                                // Check if it's likely a link or button
                                let target = el;
                                while (target && target.tagName !== 'A' && target.tagName !== 'BUTTON' && target.tagName !== 'BODY') {
                                  target = target.parentElement as HTMLElement;
                                }
                                
                                if (target && (target.tagName === 'A' || target.tagName === 'BUTTON' || el.onclick || el.getAttribute('role') === 'button')) {
                                  ['mousedown', 'mouseup', 'click'].forEach(evt => {
                                    el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                                  });
                                  if (target !== el) target.click();
                                }
                              }
                            }, jitterX, jitterY).catch(() => {});
                            
                            // Wait again after JS click
                            await new Promise(r => setTimeout(r, 5000));
                            openedPage = await newPagePromise;
                            currentUrl = page.url();
                            navigatedInSameTab = currentUrl !== startUrl;
                          }
                          
                          await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
                          
                          if (decision.action === 'CLOSE_POPUP') {
                            session.popupCloseCount++;
                            addLog(uid, `Popup closed (Total: ${session.popupCloseCount}).`);
                            
                            // Check if a new page was opened by mistake during CLOSE_POPUP
                            if (openedPage) {
                              addLog(uid, "Popup click opened an unwanted tab. Closing it...");
                              await openedPage.close().catch(() => {});
                            }

                            // Force hide element at coordinates
                            await page.evaluate((x, y) => {
                              const el = document.elementFromPoint(x, y);
                              if (el) {
                                const htmlEl = el as HTMLElement;
                                htmlEl.style.display = 'none';
                                htmlEl.style.visibility = 'hidden';
                                htmlEl.style.opacity = '0';
                                htmlEl.style.pointerEvents = 'none';
                                const parent = htmlEl.parentElement;
                                if (parent && (parent.offsetWidth < 500 || parent.offsetHeight < 500)) {
                                  parent.style.display = 'none';
                                }
                              }
                            }, jitterX, jitterY).catch(() => {});
                          } else {
                            // Handle navigation (either new tab or same tab)
                            if (openedPage || navigatedInSameTab) {
                              const targetPage = openedPage || page;
                              addLog(uid, `${decision.action === 'CLICK_AD' ? 'Ad' : 'Link'} opened. Simulating human visit...`);
                              
                              const visitWaitTime = 15000 + Math.random() * 15000; // 15-30 seconds
                              const visitStartTime = Date.now();
                              
                              while (Date.now() - visitStartTime < visitWaitTime) {
                                if (!session.isRunning) break;
                                const scrollAmt = Math.random() > 0.3 ? Math.random() * 500 : -(Math.random() * 200);
                                await targetPage.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmt).catch(() => {});
                                await captureAndBroadcast(targetPage);
                                await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
                              }
                              
                              if (openedPage) {
                                addLog(uid, "Closing ad/link tab and returning to main page.");
                                await openedPage.close().catch(() => {});
                              } else {
                                addLog(uid, "Navigating back to main page.");
                                await page.goBack().catch(() => {});
                              }
                              
                              await captureAndBroadcast();
                            }
                          }
                        }
                      } else if (decision.action === 'SCROLL') {
                        const scrollAmount = Math.random() > 0.3 ? 400 : -200;
                        await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmount);
                      } else if (decision.action === 'WAIT') {
                        addLog(uid, "Simulating human reading/waiting...");
                        // Random mouse movement while waiting
                        for (let j = 0; j < 3; j++) {
                          const mx = Math.random() * randomViewport.width;
                          const my = Math.random() * randomViewport.height;
                          await page.mouse.move(mx, my, { steps: 20 }).catch(() => {});
                          await new Promise(r => setTimeout(r, 1000));
                        }
                      } else if (decision.action === 'NAVIGATE_BACK') {
                        addLog(uid, "Navigating back...");
                        await page.goBack({ waitUntil: 'networkidle2' }).catch(() => {});
                      }
                    } else {
                      // Fallback if AI decision is null
                      addLog(uid, "AI decision timed out or failed. Using fallback: SCROLL");
                      const scrollAmount = Math.random() > 0.3 ? 400 : -200;
                      await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmount);
                    }
                  }
                } else {
                  // Non-AI cycle: Perform random human-like movement to save quota
                  const rand = Math.random();
                  if (rand > 0.4) {
                    const scrollAmt = Math.random() > 0.3 ? 300 : -150;
                    broadcastAction(uid, 'SCROLL');
                    await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), scrollAmt);
                  } else {
                    // Random mouse movement
                    addLog(uid, "Simulating human reading...");
                    const mx = Math.random() * randomViewport.width;
                    const my = Math.random() * randomViewport.height;
                    await page.mouse.move(mx, my, { steps: 20 }).catch(() => {});
                    await new Promise(r => setTimeout(r, 1000));
                  }
                  await captureAndBroadcast();
                }
                await captureAndBroadcast();
              } catch (e) {}

              if (session.isRunning) {
                const nextDelay = 3000 + Math.random() * 4000; // Faster cycle: 3-7s
                setTimeout(runCycle, nextDelay);
              }
            };

            runCycle();

            while (session.isRunning && (Date.now() - stepStartTime < waitTime)) {
              await new Promise(r => setTimeout(r, 1000));
              if (Math.random() > 0.8) await captureAndBroadcast(); // Extra updates
            }
            await page.close().catch(() => {});
          }

          if (session.browser) {
            addLog(uid, "Closing current browser session...");
            await session.browser.close().catch(() => {});
            session.browser = null;
          }
          
          session.currentScreenshot = null;
          broadcastFrame(uid, '', randomViewport.width, randomViewport.height);
          const interVisitDelay = 3000 + Math.random() * 5000;
          broadcastProgress(uid, i + 1, visits); // Update progress after completion
          await new Promise(r => setTimeout(r, interVisitDelay)); 
        }
      } catch (err: any) {
        addLog(uid, `Error: ${err.message}`);
      } finally {
        session.isRunning = false;
        session.currentScreenshot = null;
        if (session.browser) {
          await session.browser.close().catch(() => {});
          session.browser = null;
        }
        addLog(uid, 'Bot Engine Stopped.');
      }
    })();

    res.json({ message: 'Bot started' });
  });

  app.post('/api/stop', (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID is required' });
    const session = getOrCreateSession(uid);
    session.isRunning = false;
    res.json({ message: 'Stop signal sent' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Running on http://localhost:${PORT}`);
  });
}

startServer();

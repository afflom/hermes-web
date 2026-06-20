import { chromium } from "@playwright/test";
const BASE = process.argv[2] || "http://localhost:4178/";
const b = await chromium.launch(); const p = await b.newPage();
const logs = [];
p.on("console", m => { if (["error","warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
p.on("pageerror", e => logs.push("[pageerror] " + e.message));
await p.goto(BASE, { waitUntil: "load" });
let ctl=false; for (let i=0;i<40;i++){ try{ if(await p.evaluate("!!(navigator.serviceWorker&&navigator.serviceWorker.controller)")){ctl=true;break;} }catch{} await p.waitForTimeout(500);} 
console.log("SW controlled:", ctl, "| url:", p.url());
// 1. fetch flat app entry through SW
const fe = await p.evaluate(async (u) => { try { const r=await fetch(u); return {status:r.status, ctype:r.headers.get("content-type"), len:(await r.text()).length}; } catch(e){ return {err:String(e)}; } }, BASE+"apps/hermes/index.html");
console.log("fetch apps/hermes/index.html:", JSON.stringify(fe));
// 2. fetch the app lock + catalog
const lk = await p.evaluate(async (u) => { try { const r=await fetch(u); const j=await r.json(); return {status:r.status, root:j.root, keys:Object.keys(j.closure||{}).slice(0,3)}; } catch(e){ return {err:String(e)}; } }, BASE+"apps/hermes/holospace.lock.json");
console.log("fetch apps/hermes/holospace.lock.json:", JSON.stringify(lk));
// 3. mount via launcher
await p.goto(BASE+"holospace.html?app=foundation.uor.hermes", { waitUntil:"load" });
await p.waitForTimeout(4000);
const mount = await p.evaluate(() => { const f=document.querySelector("iframe"); return { hasIframe:!!f, src:f?.getAttribute("src")||null, hasSrcdoc:!!f?.getAttribute("srcdoc"), title:document.title, bodyText:document.body.innerText.slice(0,200) }; });
console.log("launcher mount:", JSON.stringify(mount,null,1));
// reach into iframe
try { const fr=p.frameLocator("iframe"); const shell=await fr.locator("[data-testid=holo-static-shell]").count(); const root=await fr.locator("#root").count(); console.log("iframe: holo-static-shell count=",shell," #root count=",root); } catch(e){ console.log("iframe read err:", String(e).slice(0,150)); }
console.log("--- logs ---\n"+logs.slice(0,15).join("\n"));
await b.close();

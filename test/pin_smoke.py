import sys, json, http.server, threading, functools, os
from playwright.sync_api import sync_playwright
web = os.path.join(os.path.dirname(__file__), "..", "web")
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=web)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
STUB = """
window.__vault = {};
window.TrackNative = {send(m){ const q = JSON.parse(m); let v = null;
  if (q.action==='config') v={url:'https://x.test',key:'k',faceID:false};
  else if (q.action==='verifyPIN') v = q.pin==='1234';
  else if (q.action==='readTraktSession') v = window.__vault[q.scope]||null;
  else if (q.action==='saveTraktSession') { window.__vault[q.scope]=q.data; v=true; }
  else if (q.action==='clearTraktSession') { delete window.__vault[q.scope]; v=true; }
  else if (q.action==='request') { v = {status:200,data:{}}; if (q.url.includes('/auth/v1/token')) v.data={access_token:'a',refresh_token:'r',user:{id:'u1'}};
    if (q.url.includes('device-auth')) { const b=q.body||{}; if (b.action==='get_state') v.data={sections:{'profile.p1':{data:{pinHash:'h'}},catalogmeta:{data:null},collections:{data:{}}}}; else v.data={}; }
    if (q.url.includes('profiles')) v.data=[{id:'p1',name:'Test'}]; }
  setTimeout(()=>window.reply(q.id,{value:v}),0); }};
"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width":390,"height":844})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script(STUB)
    pg.goto(f"http://127.0.0.1:{port}/index.html"); pg.wait_for_timeout(4500)
    # render the PIN screen directly through the page's own function if exposed
    pg.evaluate("document.getElementById('splash').hidden=true")
    pg.evaluate("settings={url:'https://x.test',key:'k'}; session={access_token:'a',refresh_token:'r',user:{id:'u1'}}; select({id:'p1',name:'Test'})")
    pg.wait_for_selector(".pin-boxes")
    assert pg.locator(".pin-boxes i").count() == 4
    for k in "12": pg.click(f".pin-key:text-is('{k}')")
    assert pg.locator(".pin-boxes i").nth(1).inner_text() == "2", "laatste cijfer even zichtbaar"
    assert pg.locator(".pin-boxes i").nth(0).inner_text() == "•"
    pg.wait_for_timeout(1000)
    assert pg.locator(".pin-boxes i").nth(1).inner_text() == "•", "daarna een punt"
    for k in "99": pg.click(f".pin-key:text-is('{k}')")
    pg.wait_for_timeout(300)
    assert pg.locator(".pin-boxes i.filled").count() == 0, "na foute code leeg"
    for n in range(4):
        for k in "9999": pg.click(f".pin-key:text-is('{k}')")
        pg.wait_for_timeout(700); print(n, pg.evaluate('document.querySelector(".pin-form")!==null'), pg.evaluate('JSON.stringify(attempts)') if False else '')
    txt = pg.locator(".pin-wait").inner_text(); print("wachtmelding:", txt)
    assert "Te veel foute pogingen" in txt
    assert pg.evaluate("JSON.parse(window.__vault['pin.p1']).failures") >= 5
    pg.screenshot(path=os.environ.get("SHOT","pin.png"))
    print("fouten:", errs); assert not errs
    b.close()

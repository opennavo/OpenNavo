""" Run through browser-use CLI; access only the prod-verify loopback admin site, without reading secrets."""
import base64
import json
from pathlib import Path
import time


directory = Path('apps/server/tmp/review/production_browser')
ready = json.loads((directory / 'ready.json').read_text())
origin = 'http://admin.opennavo.localhost:28180'
assert ready['adminUrl'] == origin, 'only the isolated production verification origin is allowed'
checks = [
    ('/release/desktop', '/admin-api/desktop-releases', ['Desktop releases', '0.3.0', 'Edit notes']),
    ('/release/mirror', '/admin-api/mirrors', ['Download mirrors', 'Official']),
    ('/release/config', '/admin-api/app-config', ['Remote config', 'desktop.minSupportedVersion', 'web.opennavo.localhost:28180/download']),
    ('/changelog/release', '/admin-api/releases', ['Releases', '1.140.0']),
    ('/changelog/review', '/admin-api/translations/queue', ['Translations', '1.135.0', '1.134.0', '1.133.0']),
]
assert {item[0] for item in checks} == set(ready['pages'])
tab_record = directory / 'tab.json'
existing = json.loads(tab_record.read_text()) if tab_record.is_file() else None
tabs = list_tabs()
owned = next((tab for tab in tabs if existing and tab.get('targetId', tab.get('target_id')) == existing['targetId']), None)
if owned:
    switch_tab(existing['targetId'])
    assert page_info()['url'].startswith(origin + '/'), 'owned verification tab changed origin'
else:
    new_tab(origin + '/login')
    tab_record.write_text(json.dumps({'targetId': current_tab()['targetId']}))

# Record only paths, business codes, and row counts; exclude account data, tokens, and response bodies from results.
trace = r'''(() => {
  const state = window.__opennavoDrill = { api: [], errors: 0, consoleErrors: 0 };
  addEventListener('error', () => state.errors++);
  addEventListener('unhandledrejection', () => state.errors++);
  const error = console.error.bind(console);
  console.error = (...args) => { state.consoleErrors++; error(...args); };
  function record(url, status, body) {
    const path = new URL(url, location.href).pathname;
    if (!path.startsWith('/admin-api/')) return;
    const data = body?.data;
    const records = Array.isArray(data) ? data : data?.records;
    state.api.push({ path, status, code: body?.code ?? null, records: Array.isArray(records) ? records.length : null });
  }
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...args) {
    const url = args[1];
    this.addEventListener('load', () => {
      let body;
      try { body = typeof this.response === 'object' ? this.response : JSON.parse(this.responseText); } catch {}
      record(url, this.status, body);
    });
    return open.apply(this, args);
  };
  const fetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await fetch.apply(this, args);
    let body;
    try { body = await response.clone().json(); } catch {}
    record(typeof args[0] === 'string' ? args[0] : args[0].url, response.status, body);
    return response;
  };
})()'''
cdp('Page.addScriptToEvaluateOnNewDocument', source=trace)
# The isolated project's database is recreated each run; clear only the verification origin created by this script.
js('localStorage.clear(); sessionStorage.clear()')
goto_url(origin + '/login')
wait_for_load()
# Hidden local Chrome tabs do not process input; activate only the verification tab created here.
if js('document.visibilityState') == 'hidden':
    activate_tab(current_tab())


def click_named(role, name):
    nodes = cdp('Accessibility.getFullAXTree')['nodes']
    node = next(item for item in nodes if item.get('role', {}).get('value') == role and item.get('name', {}).get('value') == name)
    box = cdp('DOM.getBoxModel', backendNodeId=node['backendDOMNodeId'])['model']['content']
    click_at_xy(sum(box[0::2]) / 4, sum(box[1::2]) / 4)


click_named('textbox', 'Please enter user name')
cdp('Input.insertText', text='verification-admin')
click_named('textbox', 'Please enter password')
cdp('Input.insertText', text='verification-admin-password')
assert js('document.querySelector("input[type=text]").value === "verification-admin"')
assert js('document.querySelector("input[type=password]").value.length === 27')
click_named('button', 'Log In')
deadline = time.monotonic() + 15
while True:
    state = js('window.__opennavoDrill')
    paths = {item['path'] for item in state['api'] if item['status'] == 200 and item['code'] == '0000'}
    if {'/admin-api/auth/login', '/admin-api/auth/getUserInfo'}.issubset(paths):
        break
    if time.monotonic() > deadline:
        raise RuntimeError('isolated production login failed; response bodies suppressed')
    time.sleep(0.2)
assert state['errors'] == 0 and state['consoleErrors'] == 0
result = {'browser': 'browser-use', 'loginVerified': True, 'pages': []}
for path, endpoint, markers in checks:
    goto_url(origin + path)
    wait_for_load()
    deadline = time.monotonic() + 15
    while True:
        state = js('window.__opennavoDrill')
        visible = js('document.body.innerText')
        responses = [item for item in state['api'] if item['path'] == endpoint]
        if responses and all(marker in visible for marker in markers):
            break
        if time.monotonic() > deadline:
            raise RuntimeError('production data missing for ' + path)
        time.sleep(0.2)
    time.sleep(0.3)
    state = js('window.__opennavoDrill')
    assert all(item['status'] == 200 and item['code'] == '0000' for item in state['api']), path
    assert all(item['records'] and item['records'] > 0 for item in responses), path
    assert state['errors'] == 0 and state['consoleErrors'] == 0, path
    screenshot = directory / ('admin_' + path.strip('/').replace('/', '_') + '.png')
    screenshot.write_bytes(base64.b64decode(cdp('Page.captureScreenshot', format='png', captureBeyondViewport=False)['data']))
    result['pages'].append({'path': path, 'passed': True, 'api': state['api'], 'markers': markers,
                           'errors': state['errors'], 'consoleErrors': state['consoleErrors'], 'screenshot': str(screenshot)})
    print({'path': path, 'records': responses[-1]['records'], 'errors': 0, 'consoleErrors': 0}, flush=True)
(directory / 'done.tmp').write_text(json.dumps(result, ensure_ascii=False, indent=2))
(directory / 'done.tmp').replace(directory / 'done.json')

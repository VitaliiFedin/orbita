/* Фоновий потік: виконання Python-коду учня через Pyodide.
 * Головна сторінка може будь-коли завершити потік (обмеження часу), тому тут немає власних таймерів. */
importScripts('../pyodide/pyodide.js');

const HARNESS = `
import sys, io, json, traceback

def __run_one(code, inputs, echo):
    out = io.StringIO()
    feed = list(inputs)
    def _input(prompt=''):
        if echo:
            out.write(str(prompt))
        if not feed:
            raise EOFError('__NOINPUT__')
        v = feed.pop(0)
        if echo:
            out.write(v + '\\n')
        return v
    g = {'__name__': '__main__', 'input': _input}
    old = sys.stdout
    sys.stdout = out
    err = None
    try:
        exec(compile(code, '<програма>', 'exec'), g)
    except SyntaxError as e:
        err = {'type': type(e).__name__, 'line': e.lineno, 'msg': str(e.msg)}
    except BaseException as e:
        line = None
        for fr in traceback.extract_tb(e.__traceback__):
            if fr.filename == '<програма>':
                line = fr.lineno
        err = {'type': type(e).__name__, 'line': line, 'msg': str(e)}
    finally:
        sys.stdout = old
    return {'out': out.getvalue(), 'err': err, 'unused': len(feed)}

def __run_many(code, tests_json, echo):
    tests = json.loads(tests_json)
    return json.dumps([__run_one(code, t, echo) for t in tests])
`;

const ready = (async () => {
  const py = await loadPyodide({ indexURL: new URL('../pyodide/', self.location).href });
  py.runPython(HARNESS);
  return py;
})();

self.onmessage = async (e) => {
  const { id, code, inputs, echo } = e.data;
  try {
    const py = await ready;
    const fn = py.globals.get('__run_many');
    const res = JSON.parse(fn(code, JSON.stringify(inputs), !!echo));
    fn.destroy();
    self.postMessage({ id, ok: true, results: res });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
ready.then(() => self.postMessage({ ready: true })).catch(err => self.postMessage({ ready: false, error: String(err) }));

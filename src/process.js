import { spawn } from 'node:child_process';

export function runProcess(command, args, { signal, timeoutMs = 300000, maxOutput = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', failure;
    const stop = error => { failure ||= error; child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref(); };
    let killTimer;
    const abort = () => stop(new DOMException('Отменено', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('Загрузка заняла слишком много времени.')), timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutput) stop(new Error('Слишком большой ответ загрузчика.'));
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) {
        const error = new Error(`Загрузчик завершился с кодом ${code}: ${stderr.slice(-2000)}`);
        Object.assign(error, { command, exitCode: code, stderr });
        reject(error);
      }
      else resolve(stdout);
    });
  });
}

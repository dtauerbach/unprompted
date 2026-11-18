// Runs a child process without blocking the eval's own event loop, so the
// recorder (recorder.ts), which answers the agent's requests from this same
// process, keeps serving while the agent runs. spawnSync would stall every
// request the agent made. It keeps spawnSync's limits: a deadline, after
// which the child is stopped (ETIMEDOUT), and a cap on what it may print,
// past which it is stopped too (ENOBUFS). It resolves only once the child
// has exited, so cleanup after it never races the child.
import { spawn } from "node:child_process";

export type Ran = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: { code: string; message: string };
};

export function run(
  cmd: string,
  args: string[],
  opts: {
    env: Record<string, string | undefined>;
    timeoutMs: number;
    maxBytes: number;
  },
): Promise<Ran> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let error: Ran["error"];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({
        stdout: "",
        stderr: "",
        status: null,
        error: { code: "ESPAWN", message: String(e) },
      });
    }
    // Stop it, and if it ignores that, stop it hard.
    const stop = (code: string, message: string) => {
      if (error) return;
      error = { code, message };
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const timer = setTimeout(
      () => stop("ETIMEDOUT", `ran past ${opts.timeoutMs} ms`),
      opts.timeoutMs,
    );
    const take = (into: Buffer[]) => (c: Buffer) => {
      size += c.length;
      if (size > opts.maxBytes)
        return stop("ENOBUFS", `printed more than ${opts.maxBytes} bytes`);
      into.push(c);
    };
    child.stdout?.on("data", take(out));
    child.stderr?.on("data", take(err));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (!error) error = { code: e.code ?? "ESPAWN", message: e.message };
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        status,
        ...(error ? { error } : {}),
      });
    });
  });
}

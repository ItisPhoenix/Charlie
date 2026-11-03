import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

type HostResponse = {
  ok?: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number | null;
  status?: string;
};

export async function executeGordonHostCommand(input: {
  runId: string;
  effectId: string;
  command: string;
}): Promise<HostResponse> {
  const socketPath = process.env.CHARLIE_GORDON_HOST_SOCKET;
  const keyPath = process.env.CHARLIE_OWNER_WORKER_KEY_FILE;

  if (!socketPath || !keyPath)
    return { error: "Ubuntu host control is not configured" };

  if (!input.command || Buffer.byteLength(input.command, "utf8") > 8192)
    return { error: "Invalid host command length" };

  const key = readFileSync(keyPath, "utf8").trim();

  const response = await fetch(
    "http://api:3100/api/internal/charlie/authorize",
    {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: {
        "content-type": "application/json",
        "x-charlie-worker-key": key,
      },
      body: JSON.stringify({
        gordon_run_id: input.runId,
        effect_id: input.effectId,
        command: input.command,
      }),
    },
  );

  if (!response.ok)
    return { error: `Host authority denied (HTTP ${response.status})` };

  const envelope = await response.json() as Record<string, unknown>;

  if (
    typeof envelope.grant_b64 !== "string" ||
    typeof envelope.signature_b64 !== "string"
  ) return { error: "Invalid host authorization" };

  return await new Promise<HostResponse>((resolve, reject) => {
    let output = "";
    let finished = false;
    const socket = createConnection({ path: socketPath });

    socket.setTimeout(85000, () =>
      socket.destroy(new Error("Host execution timed out")),
    );

    socket.on("connect", () => {
      socket.write(JSON.stringify({
        command: input.command,
        grant: envelope,
      }) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");

      if (output.length > 65536) {
        socket.destroy(new Error("Host response exceeded limit"));
        return;
      }

      const end = output.indexOf("\n");
      if (end < 0 || finished) return;

      finished = true;
      try {
        resolve(JSON.parse(output.slice(0, end)) as HostResponse);
      } catch {
        reject(new Error("Invalid host response"));
      }
      socket.end();
    });

    socket.on("error", reject);
    socket.on("end", () => {
      if (!finished) reject(new Error("Host socket closed without a result"));
    });
  });
}

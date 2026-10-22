import { createServer, type Server } from 'node:http';

export interface FakeAnthropic {
  url: string;
  bodies: Array<Record<string, unknown>>;
  server: Server;
}

/** A fake Messages endpoint: records each request body and answers with `reply(body)`. */
export async function fakeAnthropic(
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
): Promise<FakeAnthropic> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += String(d)));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      bodies.push(body);
      const r = reply(body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, bodies, server };
}

/** A 200 Messages response for `body`, with `extra` (content, stop_reason, …) merged in. */
export function message(body: Record<string, unknown>, extra: Record<string, unknown>) {
  return {
    status: 200,
    json: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: body['model'],
      usage: { input_tokens: 10, output_tokens: 0 },
      ...extra,
    },
  };
}

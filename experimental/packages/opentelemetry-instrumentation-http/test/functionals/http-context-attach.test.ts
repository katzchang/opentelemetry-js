/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContextManager, Span } from '@opentelemetry/api';
import { context, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { isTracingSuppressed } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import * as assert from 'assert';
import type { Socket } from 'net';
import { HttpInstrumentation } from '../../src/http';
import type { HttpInstrumentationConfig } from '../../src/types';

const instrumentation = new HttpInstrumentation();
instrumentation.enable();
instrumentation.disable();

import * as http from 'http';

const memoryExporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: memoryExporter })],
});
instrumentation.setTracerProvider(provider);
const tracer = provider.getTracer('test');

const activeSpanId = () => trace.getActiveSpan()?.spanContext().spanId;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function withParent<T>(name: string, fn: (parent: Span) => T): T {
  const parent = tracer.startSpan(name);
  return context.with(trace.setSpan(context.active(), parent), () =>
    fn(parent)
  );
}

interface ServerObservation {
  handler?: string;
  handlerImmediate?: string;
  reqData?: string;
  reqEnd?: string;
  resFinish?: string;
  resClose?: string;
  suppressed?: boolean;
  suppressedOnEnd?: boolean;
}

[false, true].forEach(useContextAttach => {
  describe(`HttpInstrumentation context propagation (useContextAttach=${useContextAttach})`, () => {
    let contextManager: ContextManager;
    let server: http.Server;
    let port: number;
    let serverObserved: ServerObservation;

    const setConfig = (config: HttpInstrumentationConfig = {}) =>
      instrumentation.setConfig({ ...config, useContextAttach });

    before(async () => {
      setConfig();
      instrumentation.enable();
      server = http.createServer((req, res) => {
        const observed: ServerObservation = {};
        serverObserved = observed;
        observed.handler = activeSpanId();
        observed.suppressed = isTracingSuppressed(context.active());
        setImmediate(() => {
          observed.handlerImmediate = activeSpanId();
        });
        req.on('data', () => {
          observed.reqData = activeSpanId();
        });
        res.on('finish', () => {
          observed.resFinish = activeSpanId();
        });
        res.on('close', () => {
          observed.resClose = activeSpanId();
        });
        req.on('end', () => {
          observed.reqEnd = activeSpanId();
          observed.suppressedOnEnd = isTracingSuppressed(context.active());
          const wait = req.url === '/slow' ? 20 : 0;
          setTimeout(() => res.end('ok'), wait);
        });
      });
      await new Promise<void>(resolve => server.listen(0, resolve));
      port = (server.address() as { port: number }).port;
    });

    after(() => {
      server.close();
      instrumentation.disable();
    });

    beforeEach(() => {
      contextManager = new AsyncLocalStorageContextManager().enable();
      context.setGlobalContextManager(contextManager);
      memoryExporter.reset();
      setConfig();
    });

    afterEach(() => {
      context.disable();
    });

    const clientSpans = () =>
      memoryExporter
        .getFinishedSpans()
        .filter(span => span.kind === SpanKind.CLIENT);

    it('runs the response callback and response listeners in the parent context', async () => {
      const result = await withParent(
        'parent',
        parent =>
          new Promise<Record<string, string | undefined>>(resolve => {
            const observed: Record<string, string | undefined> = {
              parent: parent.spanContext().spanId,
            };
            const req = http.get(`http://localhost:${port}/`, res => {
              observed.callback = activeSpanId();
              res.on('data', () => {
                observed.resData = activeSpanId();
              });
              res.on('end', () => {
                observed.resEnd = activeSpanId();
                resolve(observed);
              });
            });
            observed.afterCall = activeSpanId();
            req.on('response', () => {
              observed.reqOnResponse = activeSpanId();
            });
            req.once('finish', () => {
              observed.reqOnceFinish = activeSpanId();
            });
            req.prependListener('close', () => {
              observed.reqPrependClose = activeSpanId();
            });
          })
      );
      await delay(10);
      for (const key of [
        'afterCall',
        'callback',
        'resData',
        'resEnd',
        'reqOnResponse',
        'reqOnceFinish',
        'reqPrependClose',
      ]) {
        assert.strictEqual(result[key], result.parent, key);
      }
    });

    it(`${useContextAttach ? 'uses attach() instead of' : 'uses'} with()/bind() on the request path`, async () => {
      const manager = contextManager as AsyncLocalStorageContextManager;
      const calls = { with: 0, bind: 0, attach: 0 };
      for (const method of ['with', 'bind', 'attach'] as const) {
        const original = (manager as any)[method].bind(manager);

        (manager as any)[method] = (...args: unknown[]) => {
          calls[method]++;
          return original(...args);
        };
      }
      await new Promise<void>(resolve => {
        http.get(`http://localhost:${port}/`, res => {
          res.resume();
          res.on('end', () => resolve());
        });
      });
      await delay(10);
      if (useContextAttach) {
        assert.strictEqual(calls.bind, 0);
        assert.ok(calls.attach > 0);
      } else {
        assert.ok(calls.bind > 0);
        assert.strictEqual(calls.attach, 0);
      }
    });

    it('runs request error listeners in the parent context', async () => {
      const closed = http.createServer();
      await new Promise<void>(resolve => closed.listen(0, resolve));
      const closedPort = (closed.address() as { port: number }).port;
      await new Promise<void>(resolve => closed.close(() => resolve()));

      const [parentId, onError] = await withParent(
        'parent',
        parent =>
          new Promise<[string, string | undefined]>(resolve => {
            const req = http.get(`http://localhost:${closedPort}/`);
            req.on('error', () =>
              resolve([parent.spanContext().spanId, activeSpanId()])
            );
          })
      );
      assert.strictEqual(onError, parentId);
    });

    it('makes the client span active while the request is created', async () => {
      let inHook: string | undefined;
      let inCreateConnection: string | undefined;
      let hookSpan: string | undefined;
      setConfig({
        requestHook: (span, request) => {
          if (!('getHeader' in request)) return;
          hookSpan = span.spanContext().spanId;
          inHook = activeSpanId();
        },
      });
      class ObservingAgent extends http.Agent {
        override createConnection(
          ...args: Parameters<http.Agent['createConnection']>
        ): Socket {
          inCreateConnection = activeSpanId();

          return (http.Agent.prototype as any).createConnection.apply(
            this,
            args
          );
        }
      }
      const agent = new ObservingAgent();
      await withParent('parent', () => {
        return new Promise<void>(resolve => {
          http.get(`http://localhost:${port}/`, { agent }, res => {
            res.resume();
            res.on('end', () => resolve());
          });
        });
      });
      agent.destroy();
      assert.ok(hookSpan);
      assert.strictEqual(inHook, hookSpan);
      assert.strictEqual(inCreateConnection, hookSpan);
    });

    it('starts a request made from a response callback as a sibling client span', async () => {
      const parentId = await withParent(
        'parent',
        parent =>
          new Promise<string>(resolve => {
            http.get(`http://localhost:${port}/first`, res => {
              res.resume();
              http.get(`http://localhost:${port}/second`, res2 => {
                res2.resume();
                res2.on('end', () => resolve(parent.spanContext().spanId));
              });
            });
          })
      );
      await delay(10);
      const spans = clientSpans();
      assert.strictEqual(spans.length, 2);
      for (const span of spans) {
        assert.strictEqual(span.parentSpanContext?.spanId, parentId);
      }
    });

    it('keeps each parent context for requests queued on a single socket', async () => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const issue = (name: string) =>
        withParent(
          name,
          parent =>
            new Promise<[string, string | undefined, string | undefined]>(
              resolve => {
                http.get(`http://localhost:${port}/slow`, { agent }, res => {
                  const inCallback = activeSpanId();
                  res.resume();
                  res.on('end', () =>
                    resolve([
                      parent.spanContext().spanId,
                      inCallback,
                      activeSpanId(),
                    ])
                  );
                });
              }
            )
        );
      const results = await Promise.all([
        issue('p1'),
        issue('p2'),
        issue('p3'),
      ]);
      agent.destroy();
      await delay(10);
      for (const [parentId, inCallback, inEnd] of results) {
        assert.strictEqual(inCallback, parentId);
        assert.strictEqual(inEnd, parentId);
      }
      const parents = clientSpans()
        .map(span => span.parentSpanContext?.spanId)
        .sort();
      assert.deepStrictEqual(parents, results.map(r => r[0]).sort());
    });

    it('restores the parent context when creating the request throws', () => {
      withParent('parent', parent => {
        assert.throws(() =>
          http.get(`http://localhost:${port}/`, {
            headers: { 'x-bad': 'a\nb' },
          })
        );
        assert.strictEqual(activeSpanId(), parent.spanContext().spanId);
      });
    });

    it('does not leak the client context outside the request', async () => {
      await new Promise<void>(resolve => {
        http.get(`http://localhost:${port}/`, res => {
          res.resume();
          res.on('end', () => resolve());
        });
        assert.strictEqual(activeSpanId(), undefined);
      });
      assert.strictEqual(activeSpanId(), undefined);
    });

    it('supports removing request listeners', async () => {
      let called = false;
      await new Promise<void>(resolve => {
        const req = http.get(`http://localhost:${port}/`, res => {
          res.resume();
          res.on('end', () => resolve());
        });
        const listener = () => {
          called = true;
        };
        req.on('response', listener);
        req.removeListener('response', listener);
      });
      assert.strictEqual(called, false);
    });

    it('runs the server handler and request/response listeners in the server span context', async () => {
      await new Promise<void>(resolve => {
        const req = http.request(
          `http://localhost:${port}/`,
          { method: 'POST' },
          res => {
            res.resume();
            res.on('end', () => resolve());
          }
        );
        req.end('body');
      });
      await delay(20);
      const serverSpan = memoryExporter
        .getFinishedSpans()
        .find(span => span.kind === SpanKind.SERVER);
      assert.ok(serverSpan);
      const serverId = serverSpan.spanContext().spanId;
      assert.deepStrictEqual(serverObserved, {
        handler: serverId,
        handlerImmediate: serverId,
        reqData: serverId,
        reqEnd: serverId,
        resFinish: serverId,
        resClose: serverId,
        suppressed: false,
        suppressedOnEnd: false,
      });
    });

    it('suppresses tracing for ignored incoming requests, including listeners', async () => {
      setConfig({ ignoreIncomingRequestHook: () => true });
      await new Promise<void>(resolve => {
        http.get(`http://localhost:${port}/`, res => {
          res.resume();
          res.on('end', () => resolve());
        });
      });
      await delay(20);
      assert.strictEqual(serverObserved.suppressed, true);
      assert.strictEqual(serverObserved.suppressedOnEnd, true);
    });
  });
});

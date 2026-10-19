/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Context } from '@opentelemetry/api';
import { context } from '@opentelemetry/api';
import type { EventEmitter } from 'events';

interface ContextToken {
  dispose(): void;
}

type ContextAPIWithAttach = typeof context & {
  attach?: (ctx: Context) => ContextToken;
};

/**
 * Makes `ctx` the active context via `context.attach()`.
 *
 * Returns `undefined` when attach is unavailable, either because
 * `@opentelemetry/api` is older than 1.10 or because the registered
 * ContextManager does not implement it. Callers must then fall back to
 * `context.with()` / `context.bind()`.
 */
export function attachContext(ctx: Context): ContextToken | undefined {
  const api = context as ContextAPIWithAttach;
  if (typeof api.attach !== 'function') {
    return undefined;
  }
  const token = api.attach(ctx);
  if (context.active() !== ctx) {
    token.dispose();
    return undefined;
  }
  return token;
}

/**
 * Runs `fn` with `ctx` active, using `context.attach()` when supported and
 * `context.with()` otherwise.
 */
export function withContextAttach<T>(ctx: Context, fn: () => T): T {
  const token = attachContext(ctx);
  if (token === undefined) {
    return context.with(ctx, fn);
  }
  try {
    return fn();
  } finally {
    token.dispose();
  }
}

/**
 * Same contract as `context.bind(ctx, ee)`: listeners of `ee` run with `ctx`
 * active. Instead of wrapping every listener as it is added, `ee.emit` is
 * wrapped once, which also covers listeners added before this call.
 */
export function bindEmitterWithAttach<T extends EventEmitter>(
  ctx: Context,
  ee: T
): T {
  const originalEmit = ee.emit;
  ee.emit = function (this: T, ...args: Parameters<T['emit']>): boolean {
    const event = args[0];
    if (
      context.active() === ctx ||
      // `errorMonitor` listeners run on 'error' but are not counted.
      (event !== 'error' && this.listenerCount(event) === 0)
    ) {
      return originalEmit.apply(this, args);
    }
    const token = attachContext(ctx);
    if (token === undefined) {
      return context.with(ctx, () => originalEmit.apply(this, args));
    }
    try {
      return originalEmit.apply(this, args);
    } finally {
      token.dispose();
    }
  } as T['emit'];
  return ee;
}

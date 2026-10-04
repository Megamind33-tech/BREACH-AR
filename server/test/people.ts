import type { startHarness } from './helpers.js';

type H = Awaited<ReturnType<typeof startHarness>>;
const PK = { 'x-platform-key': 'platform-key' };
const orders = new Map<string, { orderId: string }>();

/**
 * How a person becomes a customer: an account only exists together with an order for a paid plan (POST /api/v1/checkout). This opens one the way a buyer would:
 * the owner has a plan and a way to pay on sale, the buyer checks out, confirms their email and signs in. The order is placed but not paid, so the account is on the free plan.
 */
export async function openAccount(h: H, email: string, o: { planCode?: string; audience?: 'person' | 'shop'; price?: number; name?: string; quotaGb?: number } = {}): Promise<Record<string, string>> {
  const code = o.planCode ?? 'care-year';
  await h.app.inject({ method: 'PUT', url: `/api/v1/platform/billing/plans/${code}`, headers: PK, payload: { name: o.name ?? 'Care', audience: o.audience ?? 'person', price: o.price ?? 250, currency: 'ZMW', period: 'year', active: true, ...(o.quotaGb != null ? { moveQuotaGb: o.quotaGb } : {}) } as any });
  const methodId = (await h.app.inject({ method: 'POST', url: '/api/v1/platform/billing/methods', headers: PK, payload: { kind: 'cash', label: 'Cash ' + Math.random(), instructions: 'Pay in person.' } as any })).json().id;
  const mailer = (h.app as any).mailer.outbox as { to: string; text: string }[];
  const r = await h.app.inject({ method: 'POST', url: '/api/v1/checkout', payload: { name: 'Test Person', email, password: 'a-long-password-1', acceptTerms: true, planCode: code, quantity: 1, methodId } as any });
  if (r.statusCode !== 201) throw new Error('checkout failed: ' + r.body);
  const token = mailer.filter(m => m.to === email).pop()!.text.match(/token=([\w-]+)/)![1]!;
  await h.app.inject({ method: 'GET', url: `/verify-email?token=${token}` });
  const login = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'a-long-password-1' } as any });
  const auth = { authorization: `Bearer ${login.json().token}` };
  orders.set(auth.authorization, { orderId: r.json().id });
  return auth;
}

/** The buyer tells Viro they have paid; an operator confirms the money arrived. */
export async function pay(h: H, auth: Record<string, string>): Promise<void> {
  const { orderId } = orders.get(auth.authorization)!;
  await h.app.inject({ method: 'POST', url: `/api/v1/billing/orders/${orderId}/paid`, headers: auth, payload: { payerName: 'Test Person', transactionId: 'TXN' + Math.random() } as any });
  await h.app.inject({ method: 'POST', url: `/api/v1/platform/billing/orders/${orderId}/confirm`, headers: PK, payload: {} as any });
}
export const orderOf = (auth: Record<string, string>) => orders.get(auth.authorization)!.orderId;

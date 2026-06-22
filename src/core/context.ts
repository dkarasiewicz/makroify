/** Per-request customer/store context shared by product & cart calls. */
export interface RequestContext {
  country: string;
  locale: string;
  storeId: string;
  customerId: string;
  cardholderNumber: string;
  fsdAddressId?: string;
}

/** Default delivery date = tomorrow (the shop's earliest FSD slot). */
export function defaultDeliveryDate(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return d;
}

/** "2026-06-23" */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "20260623" — the compact form used by the evaluate.article endpoints. */
export function compactDate(d: Date): string {
  return isoDate(d).replace(/-/g, "");
}

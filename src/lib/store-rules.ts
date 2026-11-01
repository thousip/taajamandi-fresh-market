export function nextDeliveryDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const tomorrow = new Date(`${value('year')}-${value('month')}-${value('day')}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

export function formatDeliveryDate(date: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T06:00:00Z`));
}

export const deliveryWindows = [
  { id: 'morning', label: 'Morning', time: '6:00 AM–10:00 AM' },
  { id: 'evening', label: 'Evening', time: '7:00 PM–9:00 PM' },
] as const;

export function toPaise(rupees: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(rupees)) throw new Error('Enter a price with at most two decimal places.');
  const [whole, decimal = ''] = rupees.split('.');
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Price is too large.');
  return amount;
}

export function hasAvailableStock(onHand: number | null | undefined, requested: number): boolean {
  return typeof onHand === 'number' && Number.isFinite(onHand) && requested > 0 && onHand >= requested;
}

export function matchesZone(pin: string, zonePins: readonly string[]): boolean {
  return /^\d{6}$/.test(pin) && zonePins.includes(pin);
}
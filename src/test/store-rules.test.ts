import { describe, expect, it } from 'vitest';
import { nextDeliveryDate, toPaise, hasAvailableStock, matchesZone, deliveryWindows, cartLineTotal, selectActualVariant, isCodPayment, formatPaise } from '@/lib/store-rules';

describe('TaajaMandi business rules', () => {
  it('offers 2 November next day at the request time', () => expect(nextDeliveryDate(new Date('2026-11-01T11:23:00Z'))).toBe('2026-11-02'));
  it('rolls over at Kolkata midnight, not UTC midnight', () => expect(nextDeliveryDate(new Date('2026-11-01T18:30:00Z'))).toBe('2026-11-03'));
  it('supports month rollover', () => expect(nextDeliveryDate(new Date('2026-11-30T11:23:00Z'))).toBe('2026-12-01'));
  it('converts price rupees to paise without floating point drift', () => expect(toPaise('49.99')).toBe(4999));
  it('rejects fractional paise', () => expect(() => toPaise('49.999')).toThrow());
  it('does not accept an order for unentered stock', () => expect(hasAvailableStock(undefined, 1)).toBe(false));
  it('does not accept an order for zero stock', () => expect(hasAvailableStock(0, 1)).toBe(false));
  it('rejects requested quantity greater than on-hand stock', () => expect(hasAvailableStock(2, 3)).toBe(false));
  it('requires the exact PIN in the zone', () => expect(matchesZone('500001', ['500002'])).toBe(false));
  it('accepts a PIN only in the matching zone', () => expect(matchesZone('500002', ['500002'])).toBe(true));
  it('keeps the two requested delivery windows', () => expect(deliveryWindows.map(slot => slot.time)).toEqual(['6:00 AM–10:00 AM', '7:00 PM–9:00 PM']));
  it('does not allow fractional basket quantities', () => expect(hasAvailableStock(5, 1.5)).toBe(false));
  it('computes basket lines in integer paise', () => expect(cartLineTotal(4999, 3)).toBe(14997));
  it('rejects invalid basket quantities', () => expect(() => cartLineTotal(4999, 0)).toThrow());
  it('does not fabricate absent 250g variants', () => expect(selectActualVariant([{ id: '500g' }], '250g')).toBeUndefined());
  it('selects only the actual variant', () => expect(selectActualVariant([{ id: '500g' }], '500g')).toEqual({ id: '500g' }));
  it('allows COD', () => expect(isCodPayment('cod')).toBe(true));
  it('rejects Razorpay checkout', () => expect(isCodPayment('razorpay')).toBe(false));
  it('rejects malformed database prices', () => expect(() => formatPaise(49.99)).toThrow());
});
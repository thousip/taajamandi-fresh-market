import { createServerFn } from '@tanstack/react-start';
import { publicKeyFetch, supabasePublicConfig } from './supabase-public-config';
import type { Availability, Catalogue, Category, Product, Variant, DeliveryZone, DeliverySlot } from './store-types';

async function publicRows<T>(table: string, columns: string): Promise<T[]> {
  const url = `${supabasePublicConfig.url}/rest/v1/${table}?select=${columns}&is_active=eq.true&limit=1000`;
  const response = await publicKeyFetch(url);
  if (!response.ok) throw new Error(`Live ${table.replaceAll('_', ' ')} could not be loaded (${response.status}).`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error('Unexpected catalogue response.');
  return rows as T[];
}

export const getCatalogue = createServerFn({ method: 'GET' }).handler(async (): Promise<Catalogue> => {
  try {
    const [categories, products, variants] = await Promise.all([
      publicRows<Category>('categories', 'id,name,slug,sort_order,is_active'),
      publicRows<Product>('products', 'id,category_id,name,telugu_name,description,sort_order,is_active'),
      publicRows<Variant>('product_variants', 'id,product_id,name,quantity,unit,price_paise,compare_at_price_paise,is_default,sort_order,is_active'),
    ]);
    let availability: Availability[] = [];
    let availabilityError: string | null = null;
    try {
      const response = await publicKeyFetch(`${supabasePublicConfig.url}/functions/v1/catalogue-availability`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Availability cannot be confirmed right now.');
      const result = await response.json() as { availability?: Availability[] };
      if (!Array.isArray(result.availability)) throw new Error('Availability cannot be confirmed right now.');
      availability = result.availability;
    } catch (error) { availabilityError = error instanceof Error ? error.message : 'Availability unavailable.'; }
    return { categories: categories.sort((a,b) => a.sort_order-b.sort_order), products: products.sort((a,b) => a.sort_order-b.sort_order), variants: variants.sort((a,b) => a.sort_order-b.sort_order), availability, availabilityError, error: null };
  } catch (error) { return { categories: [], products: [], variants: [], availability: [], availabilityError: null, error: error instanceof Error ? error.message : 'Catalogue unavailable.' }; }
});

export const getDeliveryOptions = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const [zones, slots] = await Promise.all([
      publicRows<DeliveryZone>('delivery_zones', 'id,name,pincode,delivery_fee_paise,minimum_order_paise,is_active'),
      publicRows<DeliverySlot>('delivery_slots', 'id,zone_id,label,starts_at,ends_at,is_active'),
    ]);
    return { zones, slots, error: null };
  } catch (error) { return { zones: [] as DeliveryZone[], slots: [] as DeliverySlot[], error: error instanceof Error ? error.message : 'Delivery options unavailable.' }; }
});
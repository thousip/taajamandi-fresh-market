import { useState } from 'react';
import { Leaf, Minus, Plus, Search, RefreshCw, ShoppingBasket } from 'lucide-react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { catalogueOptions } from '@/lib/store-queries';
import { cartLineTotal, formatPaise, selectActualVariant } from '@/lib/store-rules';
import type { Product } from '@/lib/store-types';

export function ProductCatalogue() {
  const { data, isFetching, refetch } = useSuspenseQuery(catalogueOptions);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState<Product | null>(null);
  const [variantId, setVariantId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const variants = data.variants.filter(variant => variant.product_id === selected?.id);
  const variant = selectActualVariant(variants, variantId);
  const availability = data.availability.find(row => row.variant_id === variant?.id);
  const products = data.products.filter(product => (category === 'all' || product.category_id === category) && `${product.name} ${product.telugu_name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  function openProduct(product: Product) {
    const options = data.variants.filter(item => item.product_id === product.id);
    setSelected(product); setVariantId((options.find(item => item.is_default) ?? options[0])?.id ?? ''); setQuantity(1);
  }
  return <section id="catalogue" className="catalogue content-width" aria-busy={isFetching}>
    <div className="catalogue-heading"><div><span className="eyebrow">THE NEIGHBOURHOOD MARKET</span><h2>Fresh picks for your kitchen<span className="heading-dot">.</span></h2></div><label className="search-field"><Search size={19}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search fresh produce" aria-label="Search fresh produce"/></label></div>
    <div className="category-line catalogue-categories"><Button variant={category === 'all' ? 'secondary' : 'outline'} onClick={() => setCategory('all')}><Leaf size={16}/> All produce</Button>{data.categories.map(item => <Button key={item.id} variant={category === item.id ? 'secondary' : 'outline'} onClick={() => setCategory(item.id)}>{item.name}</Button>)}</div>
    {data.error ? <div className="catalogue-empty" role="alert"><ShoppingBasket/><h3>The market is taking a moment</h3><p>{data.error}</p><Button variant="outline" disabled={isFetching} onClick={() => void refetch()}><RefreshCw/> Reload store</Button></div> : <>
      <div className="catalogue-status"><span>{products.length} fresh picks</span><Button variant="ghost" size="icon" aria-label="Refresh catalogue" disabled={isFetching} onClick={() => void refetch()}><RefreshCw size={16}/></Button></div>
      <p className="inline-warning" role="status">{data.availabilityError ?? 'Ordering is paused while supplier stock and checkout safeguards are verified. Prices below are from the live store.'}</p>
      {products.length === 0 ? <div className="catalogue-empty"><Search/><h3>No fresh picks found</h3><p>Try another product or category.</p></div> : <div className="product-grid">{products.map(product => {
        const options = data.variants.filter(item => item.product_id === product.id);
        const cheapest = options.reduce<number | null>((price,item) => price === null ? item.price_paise : Math.min(price,item.price_paise), null);
        return <article className="product-card" key={product.id}>
          <div className="produce-fallback" aria-label={`${product.name} photo unavailable`}><Leaf size={36} strokeWidth={1.4}/><span>TaajaMandi</span></div>
          <div className="product-card-body"><span className="product-category">{data.categories.find(item => item.id === product.category_id)?.name}</span><h3>{product.name}</h3>{product.telugu_name && <p lang="te">{product.telugu_name}</p>}<div className="product-card-price"><strong>{cheapest === null ? 'Price unavailable' : `From ${formatPaise(cheapest)}`}</strong><small>{options.length} options</small></div><Button variant="outline" onClick={() => openProduct(product)} disabled={!options.length}>Choose size <Plus size={16}/></Button></div>
        </article>;
      })}</div>}
    </>}
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="variant-dialog"><DialogHeader><DialogTitle>{selected?.name}</DialogTitle><DialogDescription>Choose your basket quantity</DialogDescription></DialogHeader><fieldset><legend className="text-sm mb-3">Size</legend><div className="variant-options">{variants.map(item => <Button key={item.id} variant={variantId === item.id ? 'secondary' : 'outline'} aria-pressed={variantId === item.id} onClick={() => setVariantId(item.id)}>{item.name}</Button>)}</div></fieldset>{variant && <><div className="variant-price"><strong>{formatPaise(variant.price_paise)}</strong>{variant.compare_at_price_paise !== null && variant.compare_at_price_paise > variant.price_paise && <del>{formatPaise(variant.compare_at_price_paise)}</del>}</div><div className="quantity-row"><span>Quantity</span><Button variant="outline" size="icon" aria-label="Decrease quantity" disabled={quantity <= 1} onClick={() => setQuantity(value => Math.max(1, value-1))}><Minus/></Button><input aria-label="Quantity" type="number" min="1" max="99" step="1" value={quantity} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 1 && value <= 99) setQuantity(value); }}/><Button variant="outline" size="icon" aria-label="Increase quantity" disabled={quantity >= 99} onClick={() => setQuantity(value => Math.min(99,value+1))}><Plus/></Button></div><div className="variant-total"><span>Item total</span><strong>{formatPaise(cartLineTotal(variant.price_paise,quantity))}</strong></div></>}<p className="text-sm text-muted-foreground" role="status">{availability?.in_stock ? 'Supplier fulfilment reported; checkout remains paused until reservations are verified.' : 'Currently unavailable for ordering.'}</p><Button disabled><ShoppingBasket/> Ordering paused</Button></DialogContent></Dialog>
  </section>;
}
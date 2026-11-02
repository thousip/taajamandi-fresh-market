import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, Leaf, ShoppingBasket, Sprout, Banknote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StoreShell } from '@/components/store-shell';
import { ProductCatalogue } from '@/components/product-catalogue';
import { catalogueOptions } from '@/lib/store-queries';
import { pageHead } from '@/lib/page-head';
import marketFresh from '@/assets/market-fresh.jpg';

export const Route = createFileRoute('/')({ loader: ({ context }) => context.queryClient.ensureQueryData(catalogueOptions), head: () => pageHead('Fresh produce in Hyderabad', 'Shop TaajaMandi for fresh vegetables and produce in Hyderabad. Browse the live catalogue and check delivery availability.'), component: Index });

function Index() {
  useSuspenseQuery(catalogueOptions);
  return <StoreShell>
    <section className="market-hero"><img src={marketFresh} alt="Fresh tomatoes, onions, carrots, okra, brinjal and coriander in a market basket" width={1536} height={1024}/><div className="hero-inner"><span className="hero-kicker"><span/> A FRESH START, EVERY DAY</span><h1>TaajaMandi<span>Goodness, by<br/>the basket.</span></h1><p>Everyday vegetables. Seasonal favourites.<br/>A little freshness for your family’s table.</p><Button size="lg" onClick={() => document.getElementById('catalogue')?.scrollIntoView({ behavior: 'smooth' })}>Explore the market <ArrowDown size={17}/></Button><div className="hero-note"><Leaf size={16}/> Rooted in freshness. Made for Hyderabad.</div></div></section>
    <section className="trust-strip" aria-label="Store values"><div><Sprout/><span><strong>Fresh by nature</strong><small>Produce for your everyday</small></span></div><div><ShoppingBasket/><span><strong>Your basket, your choice</strong><small>Choose the weight that suits you</small></span></div><div><Banknote/><span><strong>Cash on delivery</strong><small>No online payment required</small></span></div></section>
    <ProductCatalogue/><section className="fresh-band"><div className="content-width"><Leaf size={30}/><div><h2>A fresh table starts with a fresh basket.</h2><p>Simple ingredients. Everyday goodness.</p></div><ArrowRight size={28}/></div></section>
  </StoreShell>;
}

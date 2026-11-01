import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ArrowDown, ArrowRight, Leaf, Search, ShoppingBasket, Sprout, Banknote, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConnectionNotice, StoreShell } from '@/components/store-shell';
import { pageHead } from '@/lib/page-head';
import marketFresh from '@/assets/market-fresh.jpg';

export const Route = createFileRoute('/')({ head: () => pageHead('Fresh produce in Hyderabad', 'Shop TaajaMandi for fresh vegetables and produce in Hyderabad. Browse the live catalogue and check delivery availability.'), component: Index });

function Index() {
  const [query, setQuery] = useState('');
  return <StoreShell>
    <section className="market-hero"><img src={marketFresh} alt="Fresh tomatoes, onions, carrots, okra, brinjal and coriander in a market basket" width={1536} height={1024}/><div className="hero-inner"><span className="hero-kicker"><span/> A FRESH START, EVERY DAY</span><h1>TaajaMandi<span>Goodness, by<br/>the basket.</span></h1><p>Everyday vegetables. Seasonal favourites.<br/>A little freshness for your family’s table.</p><Button size="lg" onClick={() => document.getElementById('catalogue')?.scrollIntoView({ behavior: 'smooth' })}>Explore the market <ArrowDown size={17}/></Button><div className="hero-note"><Leaf size={16}/> Rooted in freshness. Made for Hyderabad.</div></div></section>
    <section className="trust-strip" aria-label="Store values"><div><Sprout/><span><strong>Fresh by nature</strong><small>Produce for your everyday</small></span></div><div><ShoppingBasket/><span><strong>Your basket, your choice</strong><small>Choose the weight that suits you</small></span></div><div><Banknote/><span><strong>Cash on delivery</strong><small>No online payment required</small></span></div></section>
    <section id="catalogue" className="catalogue content-width"><div className="catalogue-heading"><div><span className="eyebrow">THE NEIGHBOURHOOD MARKET</span><h2>Fresh picks for your kitchen<span className="heading-dot">.</span></h2></div><label className="search-field"><Search size={19}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search fresh produce" aria-label="Search fresh produce"/></label></div>
      <div className="category-line"><Button variant="secondary" className="category-selected"><Leaf size={16}/> All produce</Button><span>Live categories are currently unavailable</span></div><ConnectionNotice/>
      <div className="catalogue-empty"><span className="empty-icon"><ShoppingBasket size={39}/></span><h3>{query ? `No live results for “${query}”` : 'The market is taking a moment'}</h3><p>Your fresh picks will be here once the store reconnects.<br/>No prices or stock availability can be shown yet.</p><Button variant="outline" onClick={() => window.location.reload()}><RefreshCw/> Reload store</Button><small>Ordering is paused until live stock and delivery can be confirmed.</small></div>
    </section><section className="fresh-band"><div className="content-width"><Leaf size={30}/><div><h2>A fresh table starts with a fresh basket.</h2><p>Simple ingredients. Everyday goodness.</p></div><ArrowRight size={28}/></div></section>
  </StoreShell>;
}

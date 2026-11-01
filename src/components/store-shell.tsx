import { Link, useLocation } from '@tanstack/react-router';
import { ArrowUpRight, ShoppingBasket, Leaf, MapPin, UserRound, Package, LayoutDashboard, Truck, AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function StoreShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <div className="store-app">
    <div className="announcement"><Leaf size={14} /><span>Fresh choices. A little closer to nature.</span><span className="announcement-city">Hyderabad, Telangana</span></div>
    <header className="store-header"><div className="header-inner">
      <Link to="/" className="brand" aria-label="TaajaMandi home"><span className="brand-symbol"><ShoppingBasket size={29} /><Leaf size={15} /></span><span>Taaja<span>Mandi</span><small>తాజా మండి · FRESH EVERY DAY</small></span></Link>
      <div className="header-location"><MapPin size={19} /><div><strong>Hyderabad</strong><small>Check your delivery PIN at checkout</small></div></div>
      <nav aria-label="Main navigation"><Button variant="ghost" asChild><Link to="/orders"><UserRound /> <span>My orders</span></Link></Button><Button asChild className="cart-button"><Link to="/checkout"><ShoppingBasket /><span>My basket</span><span className="basket-count">0</span></Link></Button></nav>
    </div></header>
    <main>{children}</main>
    <footer className="store-footer"><div className="footer-inner"><div><Link to="/" className="footer-brand">TaajaMandi<Leaf size={21} /></Link><p>Fresh produce. Thoughtfully chosen.</p></div><div className="footer-links"><Link to="/">Shop</Link><Link to="/orders">My orders</Link><Link to="/admin">Store admin <ArrowUpRight size={14}/></Link><Link to="/delivery">Delivery team <ArrowUpRight size={14}/></Link></div><span className="footer-city">Made for Hyderabad.</span></div><div className="footer-bottom">© {new Date().getUTCFullYear()} TaajaMandi <span>Cash on delivery only</span></div></footer>
    <nav className="mobile-nav" aria-label="Mobile navigation">{[
      { to: '/' as const, text: 'Shop', icon: Leaf }, { to: '/checkout' as const, text: 'Basket', icon: ShoppingBasket }, { to: '/orders' as const, text: 'Orders', icon: Package }, { to: '/admin' as const, text: 'Admin', icon: LayoutDashboard },
    ].map(item => <Link key={item.to} to={item.to} className={pathname === item.to ? 'active' : ''}><item.icon size={20}/><span>{item.text}</span></Link>)}</nav>
  </div>;
}

export function ConnectionNotice({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? 'connection-notice compact' : 'connection-notice'} role="status"><AlertCircle size={20}/><div><strong>Store connection unavailable</strong><p>We couldn’t access the live catalogue. Products, prices and delivery availability cannot be confirmed right now.</p></div></div>;
}

export function PageHeading({ label, title, description, icon }: { label: string; title: string; description: string; icon?: ReactNode }) {
  return <div className="page-heading"><span className="eyebrow">{label}</span><h1>{icon}{title}</h1><p>{description}</p></div>;
}

export function DeliveryIcon() { return <Truck size={24}/>; }
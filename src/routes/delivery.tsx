import { createFileRoute } from '@tanstack/react-router';
import { Truck } from 'lucide-react';
import { ConnectionNotice, PageHeading, StoreShell } from '@/components/store-shell';
import { pageHead } from '@/lib/page-head';
export const Route = createFileRoute('/delivery')({ head: () => pageHead('Delivery team', 'Assigned TaajaMandi deliveries and delivery status updates.'), component: Delivery });
function Delivery() { return <StoreShell><div className="content-width subpage"><PageHeading label="DELIVERY OPERATIONS" title="My deliveries" description="Assigned orders and delivery updates."/><ConnectionNotice compact/><div className="access-empty"><Truck size={45}/><h2>Delivery access unavailable</h2><p>Staff sign-in and assigned deliveries cannot be verified right now.<br/>No customer addresses or delivery records are exposed.</p></div></div></StoreShell>; }
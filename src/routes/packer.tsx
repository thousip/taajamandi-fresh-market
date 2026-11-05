import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCheck, ClipboardList, Leaf, LoaderCircle, LogOut, PackageCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Toaster } from '@/components/ui/sonner';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { pageHead } from '@/lib/page-head';

export const Route = createFileRoute('/packer')({
  head: () => pageHead('Packer staff', 'TaajaMandi staff packing queue and order preparation.'),
  component: PackerPage,
});

type Item = { product_name: string; variant_name: string; quantity: number };
type Order = {
  id: string; order_number: string; status: 'pending' | 'confirmed' | 'processing';
  placed_at: string; delivery_date: string; payment_method: string; payment_status: string;
  items: Item[];
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function parseQueue(value: unknown): Order[] {
  const rows = record(value).orders;
  if (!Array.isArray(rows)) throw new Error('The packing queue could not be read. Please refresh.');
  return rows.map((value) => {
    const row = record(value);
    if (!text(row.id) || !['pending', 'confirmed', 'processing'].includes(text(row.status)) || !Array.isArray(row.items)) {
      throw new Error('An order could not be read safely. Please refresh or contact your store manager.');
    }
    const items = row.items.map((value: unknown) => {
      const item = record(value);
      if (!text(item.product_name) || typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error('An order item is incomplete. Please contact your store manager.');
      }
      return { product_name: text(item.product_name), variant_name: text(item.variant_name, 'Variant not provided'), quantity: item.quantity };
    });
    return {
      id: text(row.id), order_number: text(row.order_number, text(row.id)),
      status: row.status as Order['status'], placed_at: text(row.placed_at), delivery_date: text(row.delivery_date),
      payment_method: text(row.payment_method, 'Not provided'), payment_status: text(row.payment_status, 'Not provided'), items,
    };
  });
}
class SessionExpired extends Error {
  constructor() { super('Your session has expired. Please sign out and sign in again.'); }
}
async function invokeStaff(name: 'get-my-role' | 'packer-ops', body: Record<string, unknown>) {
  const client = getSupabaseBrowser();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError || !session) throw new SessionExpired();
  const { data, error } = await client.functions.invoke(name, {
    body, headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error) {
    const status = record(error.context).status;
    if (status === 401) throw new SessionExpired();
    if (status === 403) throw new Error('Packer staff access is required. Contact your store manager.');
    throw new Error('The staff service is unavailable. Check your connection and try again.');
  }
  if (record(data).error) throw new Error('The staff service could not complete this request. Please try again.');
  return data as unknown;
}
function dateLabel(value: string, dateOnly = false) {
  if (!value) return 'Not provided';
  const parsed = new Date(dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+05:30` : value);
  if (Number.isNaN(parsed.getTime())) return 'Not provided';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
    ...(dateOnly ? {} : { hour: 'numeric', minute: '2-digit' }),
  }).format(parsed);
}
function statusLabel(status: Order['status']) { return status === 'processing' ? 'Packing' : status === 'confirmed' ? 'Confirmed' : 'Pending'; }
function errorLabel(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

function PackerPage() {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selected, setSelected] = useState<Order | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [confirmPacked, setConfirmPacked] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const requestLock = useRef(false);
  const authLock = useRef(false);
  const identity = useRef<string | null>(null);

  useEffect(() => {
    const client = getSupabaseBrowser();
    let active = true;
    let changed = false;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (!active || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      changed = true;
      identity.current = session?.user.id ?? null;
      setUserId(identity.current);
      setSelected(null);
      setChecked(new Set());
      setInitializing(false);
    });
    void client.auth.getUser().then(({ data, error }) => {
      if (!active || changed) return;
      identity.current = data.user?.id ?? null;
      setUserId(identity.current);
      if (error && error.status !== 401 && error.status !== 403 && error.name !== 'AuthSessionMissingError') setAuthError('Unable to verify your session. Check your connection and sign in again.');
      setInitializing(false);
    }).catch(() => {
      if (active && !changed) { setAuthError('Unable to verify your session. Please try signing in.'); setInitializing(false); }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  const role = useQuery({
    queryKey: ['packer', userId, 'role'], enabled: Boolean(userId), retry: false,
    staleTime: 0,
    queryFn: async () => {
      const data = record(await invokeStaff('get-my-role', {}));
      if (!Array.isArray(data.roles)) throw new Error('Staff access could not be verified. Please try again.');
      return data.roles.includes('packer_staff');
    },
  });
  const authorized = Boolean(userId) && role.data === true && !role.isError;
  const queue = useQuery({
    queryKey: ['packer', userId, 'queue'], enabled: authorized, retry: false,
    queryFn: async () => parseQueue(await invokeStaff('packer-ops', { action: 'queue' })),
  });
  const orders = queue.data ?? [];

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (authLock.current) return;
    authLock.current = true; setAuthBusy(true); setAuthError('');
    try {
      const { error } = await getSupabaseBrowser().auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['packer'] });
    } catch (error) { setAuthError(errorLabel(error)); }
    finally { authLock.current = false; setAuthBusy(false); }
  }
  async function signOut() {
    if (authLock.current || requestLock.current) return;
    authLock.current = true; setAuthBusy(true); setAuthError('');
    try {
      await queryClient.cancelQueries({ queryKey: ['packer'] });
      queryClient.removeQueries({ queryKey: ['packer'] });
      setSelected(null); setChecked(new Set());
      const { error } = await getSupabaseBrowser().auth.signOut({ scope: 'local' });
      if (error) throw error;
      identity.current = null; setUserId(null); setPassword('');
    } catch (error) { setAuthError(errorLabel(error)); }
    finally { authLock.current = false; setAuthBusy(false); }
  }
  async function refresh() {
    if (requestLock.current || queue.isFetching) return;
    setSelected(null); setChecked(new Set()); setConfirmPacked(false); setUpdateError('');
    await queue.refetch();
  }
  function openOrder(order: Order) {
    setChecked(new Set()); setConfirmPacked(false); setUpdateError(''); setSelected(order);
  }
  const allChecked = Boolean(selected?.items.length) && selected?.items.every((_, index) => checked.has(index)) === true;
  async function updateOrder(order: Order, status: 'processing' | 'packed') {
    if (requestLock.current || !authorized || queue.isFetching || queue.isError) return;
    if (status === 'processing' && order.status !== 'pending' && order.status !== 'confirmed') return;
    if (status === 'packed' && (order.status !== 'processing' || selected?.id !== order.id || !allChecked || !confirmPacked)) return;
    const currentUser = userId;
    requestLock.current = true; setUpdating(true); setUpdateError('');
    try {
      const data = record(await invokeStaff('packer-ops', { action: 'update', order_id: order.id, status }));
      if (data.success !== true) throw new Error('The order update was not confirmed. Refresh the queue before trying again.');
      if (identity.current !== currentUser) return;
      setSelected(null); setChecked(new Set()); setConfirmPacked(false);
      toast.success(status === 'packed' ? 'Order marked packed' : 'Packing started');
      await queue.refetch();
    } catch (error) {
      if (identity.current === currentUser) { setUpdateError(errorLabel(error)); toast.error(errorLabel(error)); }
    } finally { requestLock.current = false; setUpdating(false); }
  }

  return <div className="min-h-screen bg-card font-sans text-foreground">
    <Toaster />
    <header className="border-b border-border bg-primary text-primary-foreground">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-6">
        <div className="flex items-center gap-3"><Leaf className="size-7" aria-hidden="true" /><div><div className="font-display text-2xl">TaajaMandi</div><div className="text-sm">Fresh Market · Packer staff</div></div></div>
        {userId && <Button variant="secondary" className="min-h-11" disabled={authBusy || updating} onClick={() => void signOut()}><LogOut />Sign out</Button>}
      </div>
    </header>
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {authError && <p role="alert" className="mb-5 text-destructive">{authError}</p>}
      {initializing ? <Loading label="Checking your session…" /> : !userId ?
        <div className="mx-auto max-w-sm py-10">
          <ClipboardList className="mb-4 size-10 text-primary" aria-hidden="true" /><h1 className="text-3xl">Packer sign in</h1>
          <form onSubmit={signIn} className="mt-7 space-y-5">
            <div className="space-y-2"><Label htmlFor="packer-email">Email</Label><Input id="packer-email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} className="h-12" disabled={authBusy} /></div>
            <div className="space-y-2"><Label htmlFor="packer-password">Password</Label><Input id="packer-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className="h-12" disabled={authBusy} /></div>
            <Button type="submit" className="h-12 w-full" disabled={authBusy}>{authBusy && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}{authBusy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        </div> : role.isPending ? <Loading label="Verifying staff access…" /> : role.isError ?
          <div role="alert" className="space-y-4"><h1 className="text-2xl">Access could not be verified</h1><p>{errorLabel(role.error)}</p><Button variant="outline" className="min-h-11" disabled={role.isFetching} onClick={() => void role.refetch()}><RefreshCw />Retry</Button></div> : !authorized ?
          <div className="space-y-3"><h1 className="text-3xl">Packer access required</h1><p className="text-muted-foreground">This account is not assigned to packer staff. Contact your store manager or sign in with your staff account.</p></div> : <>
            <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-3xl">Packing queue</h1><p className="mt-1 text-sm text-muted-foreground">Order preparation</p></div><Button variant="outline" className="min-h-11" onClick={() => void refresh()} disabled={queue.isFetching || updating}><RefreshCw className={queue.isFetching ? 'animate-spin motion-reduce:animate-none' : ''} />Refresh</Button></div>
            <dl className="my-7 grid grid-cols-3 border-y border-border py-5">
              {(['pending', 'confirmed', 'processing'] as const).map(status => <div key={status} className="px-2 text-center"><dt className="text-sm text-muted-foreground">{statusLabel(status)}</dt><dd className="mt-1 text-3xl font-semibold tabular-nums">{queue.isPending || queue.isError ? '—' : orders.filter(order => order.status === status).length}</dd></div>)}
            </dl>
            {updateError && <p role="alert" className="mb-4 text-destructive">{updateError}</p>}
            {queue.isPending ? <Loading label="Loading orders…" /> : queue.isError ? <div role="alert" className="space-y-3"><h2 className="text-2xl">Queue unavailable</h2><p>{errorLabel(queue.error)}</p><p className="text-sm text-muted-foreground">Refresh to get the latest orders before packing.</p></div> : !orders.length ?
              <div className="py-14 text-center"><PackageCheck className="mx-auto mb-4 size-12 text-primary" aria-hidden="true" /><h2 className="text-2xl">Queue is clear</h2><p className="mt-2 text-muted-foreground">No orders are waiting to be packed.</p></div> :
              <div className="grid gap-4 md:grid-cols-2" aria-busy={queue.isFetching || updating}>
                {orders.map(order => <article key={order.id} className="min-w-0 rounded-lg border border-border bg-card p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="break-all text-xl">#{order.order_number}</h2><span className="rounded-sm bg-secondary px-2 py-1 text-sm font-medium text-secondary-foreground">{statusLabel(order.status)}</span></div>
                  <p className="mt-2 text-sm text-muted-foreground">Placed {dateLabel(order.placed_at)}</p>
                  {order.delivery_date && <p className="mt-1 text-sm">Delivery {dateLabel(order.delivery_date, true)}</p>}
                  <p className="mt-3 break-words text-sm capitalize">{order.payment_method.replaceAll('_', ' ')} · {order.payment_status.replaceAll('_', ' ')}</p>
                  <p className="mt-4 text-sm font-semibold">{order.items.length} item lines · {order.items.reduce((total, item) => total + item.quantity, 0)} units</p>
                  <ul className="mt-2 space-y-2">{order.items.map((item, index) => <li key={index} className="flex justify-between gap-3 text-sm"><div className="min-w-0 break-words">{item.product_name}<span className="block text-muted-foreground">{item.variant_name}</span></div><span className="shrink-0 font-semibold">× {item.quantity}</span></li>)}</ul>
                  <div className="mt-5 flex flex-wrap gap-2"><Button variant="outline" className="min-h-11 flex-1" onClick={() => openOrder(order)} disabled={queue.isFetching || updating}><ClipboardList />{order.status === 'processing' ? 'Packing checklist' : 'Order details'}</Button>{order.status !== 'processing' && <Button className="min-h-11 flex-1" disabled={queue.isFetching || updating} onClick={() => void updateOrder(order, 'processing')}>Start packing</Button>}</div>
                </article>)}
              </div>}
          </>}
    </main>
    <Dialog open={Boolean(selected) && authorized && !queue.isError && !queue.isFetching} onOpenChange={open => { if (!open) { setSelected(null); setChecked(new Set()); setConfirmPacked(false); } }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-lg bg-card">
        <DialogHeader><DialogTitle className="break-all pr-5">Order #{selected?.order_number}</DialogTitle><DialogDescription>{selected ? statusLabel(selected.status) : ''} · Checklist resets when reopened or refreshed.</DialogDescription></DialogHeader>
        {selected && <>
          <p className="text-sm">Placed {dateLabel(selected.placed_at)}{selected.delivery_date && <span className="block">Delivery {dateLabel(selected.delivery_date, true)}</span>}</p>
          <ul className="space-y-2">{selected.items.map((item, index) => <li key={index}><Label htmlFor={`packer-item-${index}`} className="flex min-h-14 cursor-pointer items-center gap-4 rounded-md border border-border p-3"><Checkbox id={`packer-item-${index}`} className="size-6" disabled={updating || selected.status !== 'processing'} checked={checked.has(index)} onCheckedChange={value => { setChecked(previous => { const next = new Set(previous); if (value === true) next.add(index); else next.delete(index); return next; }); setConfirmPacked(false); }} /><span className="min-w-0 flex-1 break-words leading-5">{item.product_name}<span className="block text-sm font-normal text-muted-foreground">{item.variant_name}</span></span><span className="shrink-0">× {item.quantity}</span></Label></li>)}</ul>
          {!selected.items.length && <p role="alert">No items available. This order cannot be marked packed.</p>}
          <p className="break-words text-sm capitalize">{selected.payment_method.replaceAll('_', ' ')} · {selected.payment_status.replaceAll('_', ' ')}</p>
          {updateError && <p role="alert" className="text-destructive">{updateError}</p>}
          {selected.status === 'processing' ? <>
            {confirmPacked && <div className="space-y-3 border-t border-border pt-4"><p>Confirm all {selected.items.length} item lines are checked and this order is fully packed?</p><div className="flex gap-2"><Button variant="outline" className="min-h-11 flex-1" disabled={updating} onClick={() => setConfirmPacked(false)}>Cancel</Button><Button className="min-h-11 flex-1" disabled={updating || !allChecked} onClick={() => void updateOrder(selected, 'packed')}>{updating ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <CheckCheck />}Confirm packed</Button></div></div>}
            {!confirmPacked && <Button className="min-h-12 w-full" disabled={!allChecked || updating} onClick={() => setConfirmPacked(true)}><PackageCheck />Mark packed</Button>}
          </> : <Button className="min-h-12 w-full" disabled={updating} onClick={() => void updateOrder(selected, 'processing')}>{updating && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}Start packing</Button>}
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}

function Loading({ label }: { label: string }) {
  return <div role="status" className="flex items-center justify-center gap-3 py-14 text-muted-foreground"><LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" />{label}</div>;
}
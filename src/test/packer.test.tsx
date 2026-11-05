import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ roles: ['packer_staff'], status: 'processing', invoke: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => options }));
vi.mock('@/lib/supabase-browser', () => ({ getSupabaseBrowser: () => ({
  auth: {
    getUser: async () => ({ data: { user: { id: 'staff' } }, error: null }),
    getSession: async () => ({ data: { session: { access_token: 'test-token' } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
  }, functions: { invoke: mock.invoke },
}) }));

import { Route } from '@/routes/packer';
const Page = (Route as unknown as { component: () => React.ReactNode }).component;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
}
beforeEach(() => {
  mock.roles = ['packer_staff']; mock.status = 'processing';
  mock.invoke.mockReset();
  mock.invoke.mockImplementation(async (name: string, options: { body: Record<string, unknown> }) => {
    if (name === 'get-my-role') return { data: { roles: mock.roles }, error: null };
    if (options.body.action === 'update') { mock.status = String(options.body.status); return { data: { success: true }, error: null }; }
    return { data: { orders: mock.status === 'packed' ? [] : [{ id: '11111111-1111-4111-8111-111111111111', order_number: '42', status: mock.status, items: [{ product_name: 'Tomato', variant_name: '500g', quantity: 2 }] }] }, error: null };
  });
});
afterEach(cleanup);
describe('Packer staff safeguards', () => {
  it('never requests the queue without the packer_staff role', async () => {
    mock.roles = ['admin']; mount();
    await screen.findByText('Packer access required');
    expect(mock.invoke.mock.calls.filter(([name]) => name === 'packer-ops')).toHaveLength(0);
  });
  it('requires all items checked and confirmation before sending packed through packer-ops', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Packing checklist' }));
    const packed = await screen.findByRole('button', { name: 'Mark packed' });
    expect(packed).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(packed);
    expect(mock.invoke.mock.calls.filter(([, options]) => options.body.action === 'update')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm packed' }));
    await screen.findByText('Queue is clear');
    expect(mock.invoke).toHaveBeenCalledWith('packer-ops', expect.objectContaining({ body: { action: 'update', order_id: '11111111-1111-4111-8111-111111111111', status: 'packed' } }));
  });
  it.each(['pending', 'confirmed'])('starts %s orders with processing and refreshes the queue', async status => {
    mock.status = status; mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Start packing' }));
    await screen.findByRole('button', { name: 'Packing checklist' });
    expect(mock.invoke).toHaveBeenCalledWith('packer-ops', expect.objectContaining({ body: { action: 'update', order_id: '11111111-1111-4111-8111-111111111111', status: 'processing' } }));
  });
  it('resets the local checklist when details are reopened and after manual refresh', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Packing checklist' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Packing checklist' }));
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Packing checklist' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Packing checklist' }));
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
  });
});
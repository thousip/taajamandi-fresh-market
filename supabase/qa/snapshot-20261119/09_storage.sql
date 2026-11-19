-- part: 09_storage
-- product-images bucket settings and its storage policies (boolean rendered as true; generator printed t)
-- (the duplicate "Product images" bucket is not copied; no objects are copied).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('product-images', 'product-images', true, 5242880, '{image/jpeg,image/png,image/webp}'::text[]) on conflict (id) do nothing;

create policy "TaajaMandi admin product image delete" on storage.objects as permissive for delete to authenticated
  using (((bucket_id = 'product-images'::text) AND ( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role)));
create policy "TaajaMandi admin product image insert" on storage.objects as permissive for insert to authenticated
  with check (((bucket_id = 'product-images'::text) AND ( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role)));
create policy "TaajaMandi admin product image update" on storage.objects as permissive for update to authenticated
  using (((bucket_id = 'product-images'::text) AND ( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role)))
  with check (((bucket_id = 'product-images'::text) AND ( SELECT private.has_any_role(ARRAY['admin'::text, 'manager'::text]) AS has_any_role)));
create policy "TaajaMandi public product image read" on storage.objects as permissive for select to anon, authenticated
  using ((bucket_id = 'product-images'::text));

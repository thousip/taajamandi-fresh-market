-- READ-ONLY. Run on production and on QA; every row must be identical between the two projects.
-- Covers columns, constraints, indexes, function bodies and settings, triggers, RLS flags, policies,
-- table privileges, function privileges, the auth.users trigger and storage policies. No data is read.
with
cols as (select 'columns' k, md5(string_agg(format('%s.%s %s %s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
  a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '')), '|' order by c.relname, a.attnum)) v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum where n.nspname = 'public' and c.relkind = 'r'),
cons as (select 'constraints' k, md5(string_agg(format('%s.%s %s', c.relname, x.conname, pg_get_constraintdef(x.oid)), '|' order by c.relname, x.conname)) v
  from pg_constraint x join pg_class c on c.oid = x.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
idx as (select 'indexes' k, md5(string_agg(pg_get_indexdef(i.indexrelid), '|' order by pg_get_indexdef(i.indexrelid))) v
  from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
fns as (select 'functions' k, md5(string_agg(format('%s %s %s %s %s', p.oid::regprocedure, md5(p.prosrc), p.prosecdef, p.provolatile,
  coalesce(array_to_string(p.proconfig, ','), '')), '|' order by p.oid::regprocedure::text)) v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')),
trg as (select 'triggers' k, md5(string_agg(pg_get_triggerdef(t.oid), '|' order by pg_get_triggerdef(t.oid))) v
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users' and t.tgname = 'on_auth_user_created_taajamandi'))),
rls as (select 'rls_flags' k, md5(string_agg(format('%s %s %s', c.relname, c.relrowsecurity, c.relforcerowsecurity), '|' order by c.relname)) v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'),
pol as (select 'policies' k, md5(string_agg(format('%s.%s %s %s %s %s %s', schemaname, tablename, policyname, permissive, roles, cmd,
  coalesce(qual, '') || '/' || coalesce(with_check, '')), '|' order by schemaname, tablename, policyname)) v
  from pg_policies where schemaname in ('public') or (schemaname = 'storage' and policyname like 'TaajaMandi%')),
tpriv as (select 'table_privileges' k, md5(string_agg(format('%s %s %s', c.relname, r.rolname, p.priv), '|' order by c.relname, r.rolname, p.priv)) v
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
  where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r.rolname, c.oid, p.priv)),
fpriv as (select 'function_privileges' k, md5(string_agg(format('%s %s', p.oid::regprocedure, r.rolname), '|' order by p.oid::regprocedure::text, r.rolname)) v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
  where n.nspname in ('public','private') and has_function_privilege(r.rolname, p.oid, 'EXECUTE')),
bucket as (select 'storage_bucket' k, md5(coalesce((select format('%s %s %s %s', id, public, file_size_limit, allowed_mime_types) from storage.buckets where id = 'product-images'), 'missing')) v)
select k, v from cols union all select * from cons union all select * from idx union all select * from fns union all select * from trg
union all select * from rls union all select * from pol union all select * from tpriv union all select * from fpriv union all select * from bucket
order by 1;

-- Phase 1C: audited staff-role management (approved plan, 19 Nov 2026).
--
-- Before: admin-ops / staff-admin inserted rows into user_roles directly and wrote audit_logs as a separate,
-- unchecked call; admins and managers could grant; nothing could revoke except SQL.
-- After:
--   * Only these two functions change staff roles. They run as security definer and are executable by
--     service_role only (Edge Functions), never by anon or signed-in users.
--   * Only accounts holding the 'admin' role may grant or revoke (owner decision: admins only).
--   * Only 'packer_staff' and 'delivery_staff' can be granted or revoked; admin, manager, inventory_staff and
--     customer stay SQL-only.
--   * The role change and its audit_logs row are written in the same transaction: no change without a record.
--   * Revoking delivery_staff is refused while the person has open deliveries, and deactivates their
--     delivery profile so they disappear from the assignment list.
-- No table, column, policy or existing function is changed. Rollback: drop the two functions (see bottom).

create or replace function public.admin_grant_staff_role(p_actor_id uuid, p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_inserted integer;
begin
  if p_actor_id is null or p_user_id is null or p_role is null then
    raise exception 'Missing staff role details' using errcode = '22023';
  end if;
  if p_role not in ('packer_staff', 'delivery_staff') then
    raise exception 'Only packer or delivery staff roles can be granted' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id = p_actor_id and role = 'admin') then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;

  insert into public.user_roles (user_id, role) values (p_user_id, p_role)
  on conflict (user_id, role) do nothing;
  get diagnostics v_inserted = row_count;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'staff_role_granted', 'user', p_user_id,
          jsonb_build_object('role', p_role, 'already_had_role', v_inserted = 0));

  return jsonb_build_object('user_id', p_user_id, 'role', p_role, 'granted', v_inserted > 0);
end;
$function$;

create or replace function public.admin_revoke_staff_role(p_actor_id uuid, p_user_id uuid, p_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare v_deleted integer; v_open integer;
begin
  if p_actor_id is null or p_user_id is null or p_role is null then
    raise exception 'Missing staff role details' using errcode = '22023';
  end if;
  if p_role not in ('packer_staff', 'delivery_staff') then
    raise exception 'Only packer or delivery staff roles can be removed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.user_roles where user_id = p_actor_id and role = 'admin') then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  if p_role = 'delivery_staff' then
    select count(*) into v_open
    from public.delivery_assignments da
    join public.delivery_staff ds on ds.id = da.delivery_staff_id
    where ds.user_id = p_user_id and da.status in ('assigned', 'accepted', 'picked_up');
    if v_open > 0 then
      raise exception 'Reassign this person''s % open deliveries before removing them', v_open using errcode = '22023';
    end if;
    update public.delivery_staff set is_active = false, is_available = false, updated_at = now()
    where user_id = p_user_id;
  end if;

  delete from public.user_roles where user_id = p_user_id and role = p_role;
  get diagnostics v_deleted = row_count;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'staff_role_revoked', 'user', p_user_id,
          jsonb_build_object('role', p_role, 'had_role', v_deleted > 0,
                             'reason', nullif(left(btrim(coalesce(p_reason, '')), 500), '')));

  return jsonb_build_object('user_id', p_user_id, 'role', p_role, 'revoked', v_deleted > 0);
end;
$function$;

revoke all on function public.admin_grant_staff_role(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_revoke_staff_role(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_grant_staff_role(uuid, uuid, text) to service_role;
grant execute on function public.admin_revoke_staff_role(uuid, uuid, text, text) to service_role;

-- Rollback (if ever needed):
--   drop function if exists public.admin_grant_staff_role(uuid, uuid, text);
--   drop function if exists public.admin_revoke_staff_role(uuid, uuid, text, text);

-- Owner-approved launch booking rules (18 Nov 2026), all in Asia/Kolkata:
--   before 1 Dec 2026: advance orders only, delivery date 1 Dec 2026 or later (default 1 Dec);
--   from 1 Dec 2026:   same-day (date = today) or advance (date > today).
-- Fixes: the previous trigger re-validated the schedule on EVERY update, so once a delivery date
-- had passed, status changes (packed, delivered, cancelled) on that order were rejected.
-- Now validation runs on INSERT and only when delivery_date/delivery_type actually change.

create or replace function public.enforce_taajamandi_delivery_schedule()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start constant date := date '2026-12-01';
begin
  if tg_op = 'UPDATE'
     and new.delivery_date is not distinct from old.delivery_date
     and new.delivery_type is not distinct from old.delivery_type then
    return new; -- schedule unchanged: never block status/payment updates
  end if;

  if new.delivery_type is null then
    new.delivery_type := case when v_today < v_start then 'advance' else 'same_day' end;
  end if;
  if new.delivery_date is null then
    new.delivery_date := case when v_today < v_start then v_start
                              when new.delivery_type = 'advance' then v_today + 1
                              else v_today end;
  end if;

  if v_today < v_start then
    if new.delivery_type <> 'advance' or new.delivery_date < v_start then
      raise exception 'Deliveries start on 1 December 2026; choose 1 December or a later delivery date'
        using errcode = '22023';
    end if;
  elsif new.delivery_type = 'same_day' and new.delivery_date <> v_today then
    raise exception 'Same-day delivery must be scheduled for today' using errcode = '22023';
  elsif new.delivery_type = 'advance' and new.delivery_date <= v_today then
    raise exception 'Advance delivery must be scheduled for a future date' using errcode = '22023';
  end if;
  return new;
end;
$function$;

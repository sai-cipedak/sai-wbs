create or replace function public.evidence_actor_is_authority(p_case_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $function$
  select exists(
    select 1 from public.cases c join public.profiles p on p.user_id=p_user_id and p.organization_id=c.organization_id and p.is_active
    where c.id=p_case_id and exists(
      select 1 from public.user_system_roles r where r.user_id=p_user_id and r.organization_id=c.organization_id
      and r.active_from<=now() and (r.active_until is null or r.active_until>now())
      and r.role_code = any(case c.authority_code
        when 'TRIAGE' then array['TRIAGE','SECRETARIAT']::text[]
        when 'SECRETARIAT' then array['SECRETARIAT']::text[]
        when 'DEKOM' then array['DEKOM']::text[]
        when 'HSE' then array['HSE']::text[]
        when 'GRIEVANCE' then array['GRIEVANCE_COORDINATOR']::text[]
        else array[]::text[] end)
    )
  )
$function$;

create or replace function public.finalize_evidence_upload_atomic(
 p_session_id uuid,p_case_id uuid,p_actor_user_id uuid,p_uploader_context text,p_verified_hash text,
 p_evidence_type text,p_description text,p_recovered boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_session public.case_evidence_upload_sessions%rowtype; v_case public.cases%rowtype; v_evidence_id uuid; v_new boolean:=false; v_now timestamptz:=now();
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found then raise exception 'CASE_NOT_FOUND'; end if;
 select * into v_session from public.case_evidence_upload_sessions where id=p_session_id and case_id=p_case_id for update;
 if not found then raise exception 'SESSION_NOT_FOUND'; end if;
 if v_session.uploader_context<>p_uploader_context or v_session.uploaded_by_user_id is distinct from p_actor_user_id then raise exception 'SESSION_FORBIDDEN'; end if;
 if v_session.status='FINALIZED' then
   select id into v_evidence_id from public.case_evidence where drive_file_id=v_session.drive_file_id;
   return jsonb_build_object('ok',true,'evidenceId',v_evidence_id,'alreadyFinalized',true);
 end if;
 if v_session.status<>'INITIATED' then raise exception 'SESSION_INACTIVE'; end if;
 if v_session.expires_at<=v_now then update public.case_evidence_upload_sessions set status='EXPIRED',updated_at=v_now where id=p_session_id; raise exception 'SESSION_EXPIRED'; end if;
 insert into public.case_evidence(case_id,drive_file_id,drive_folder_id,storage_filename,original_filename,mime_type,file_size_bytes,sha256_hash,evidence_type,description,uploader_context,uploaded_by_user_id,status,access_scope,review_state,reviewed_by_user_id,reviewed_at,last_verified_at)
 values(p_case_id,v_session.drive_file_id,v_session.drive_folder_id,v_session.storage_filename,v_session.original_filename,v_session.mime_type,v_session.file_size_bytes,p_verified_hash,p_evidence_type,nullif(left(trim(coalesce(p_description,'')),2000),''),v_session.uploader_context,v_session.uploaded_by_user_id,'ACTIVE',v_session.access_scope,v_session.review_state,case when v_session.review_state='CLEARED' then p_actor_user_id end,case when v_session.review_state='CLEARED' then v_now end,v_now)
 on conflict(drive_file_id) do nothing returning id into v_evidence_id;
 if v_evidence_id is not null then v_new:=true; else select id into v_evidence_id from public.case_evidence where drive_file_id=v_session.drive_file_id; end if;
 update public.case_evidence_upload_sessions set status='FINALIZED',completed_at=v_now,updated_at=v_now where id=p_session_id;
 if v_new then insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(v_case.organization_id,p_case_id,p_actor_user_id,'EVIDENCE_REGISTERED','case_evidence',v_evidence_id,jsonb_build_object('uploader_context',v_session.uploader_context,'access_scope',v_session.access_scope,'review_state',v_session.review_state,'mime_type',v_session.mime_type,'file_size_bytes',v_session.file_size_bytes,'sha256_verified',p_verified_hash is not null,'recovered_after_browser_cors',p_recovered)); end if;
 return jsonb_build_object('ok',true,'evidenceId',v_evidence_id,'alreadyFinalized',not v_new,'sha256Verified',p_verified_hash is not null,'reviewState',v_session.review_state,'accessScope',v_session.access_scope);
end $function$;

create or replace function public.review_evidence_atomic(p_case_id uuid,p_evidence_id uuid,p_actor_user_id uuid,p_review_state text,p_access_scope text,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare v_case public.cases%rowtype; v_scope text:=p_access_scope; v_ev public.case_evidence%rowtype;
begin
 select * into v_case from public.cases where id=p_case_id for update; if not found then raise exception 'CASE_NOT_FOUND'; end if;
 if not public.evidence_actor_is_authority(p_case_id,p_actor_user_id) then raise exception 'FORBIDDEN'; end if;
 if v_case.status in ('CLOSED','OUT_OF_SCOPE') then raise exception 'CASE_CLOSED'; end if;
 if p_review_state not in ('CLEARED','RESTRICTED') or v_scope not in ('AUTHORITY_ONLY','INVESTIGATION_TEAM') then raise exception 'INVALID_REVIEW'; end if;
 if p_review_state='RESTRICTED' then v_scope:='AUTHORITY_ONLY'; if char_length(trim(coalesce(p_note,'')))<5 then raise exception 'NOTE_REQUIRED'; end if; end if;
 select * into v_ev from public.case_evidence where id=p_evidence_id and case_id=p_case_id for update;
 if not found then raise exception 'EVIDENCE_NOT_FOUND'; end if; if v_ev.status<>'ACTIVE' then raise exception 'EVIDENCE_INACTIVE'; end if;
 update public.case_evidence set access_scope=v_scope,review_state=p_review_state,reviewed_by_user_id=p_actor_user_id,reviewed_at=now(),review_note=nullif(left(trim(coalesce(p_note,'')),2000),'') where id=p_evidence_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(v_case.organization_id,p_case_id,p_actor_user_id,'EVIDENCE_REVIEWED','case_evidence',p_evidence_id,jsonb_build_object('review_state',p_review_state,'access_scope',v_scope));
 return jsonb_build_object('ok',true,'evidenceId',p_evidence_id,'reviewState',p_review_state,'accessScope',v_scope);
end $function$;

create or replace function public.quarantine_evidence_atomic(p_case_id uuid,p_evidence_id uuid,p_actor_user_id uuid,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare v_case public.cases%rowtype;
begin
 select * into v_case from public.cases where id=p_case_id for update; if not found then raise exception 'CASE_NOT_FOUND'; end if;
 if not public.evidence_actor_is_authority(p_case_id,p_actor_user_id) then raise exception 'FORBIDDEN'; end if;
 if char_length(trim(coalesce(p_note,'')))<5 then raise exception 'NOTE_REQUIRED'; end if;
 perform 1 from public.case_evidence where id=p_evidence_id and case_id=p_case_id for update; if not found then raise exception 'EVIDENCE_NOT_FOUND'; end if;
 update public.case_evidence set status='QUARANTINED',access_scope='AUTHORITY_ONLY',review_state='RESTRICTED',reviewed_by_user_id=p_actor_user_id,reviewed_at=now(),review_note=left(trim(p_note),2000) where id=p_evidence_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(v_case.organization_id,p_case_id,p_actor_user_id,'EVIDENCE_QUARANTINED','case_evidence',p_evidence_id,jsonb_build_object('reason',left(trim(p_note),2000)));
 return jsonb_build_object('ok',true,'evidenceId',p_evidence_id,'status','QUARANTINED');
end $function$;

create or replace function public.mark_evidence_removed_atomic(p_case_id uuid,p_evidence_id uuid,p_actor_user_id uuid,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare v_case public.cases%rowtype; v_ev public.case_evidence%rowtype;
begin
 select * into v_case from public.cases where id=p_case_id for update; if not found then raise exception 'CASE_NOT_FOUND'; end if;
 if not public.evidence_actor_is_authority(p_case_id,p_actor_user_id) then raise exception 'FORBIDDEN'; end if;
 if char_length(trim(coalesce(p_note,'')))<5 then raise exception 'NOTE_REQUIRED'; end if;
 select * into v_ev from public.case_evidence where id=p_evidence_id and case_id=p_case_id for update; if not found then raise exception 'EVIDENCE_NOT_FOUND'; end if;
 if v_ev.status='REMOVED' then return jsonb_build_object('ok',true,'evidenceId',p_evidence_id,'status','REMOVED','alreadyRemoved',true); end if;
 update public.case_evidence set status='REMOVED',access_scope='AUTHORITY_ONLY',review_state='RESTRICTED',reviewed_by_user_id=p_actor_user_id,reviewed_at=now(),review_note=left(trim(p_note),2000) where id=p_evidence_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(v_case.organization_id,p_case_id,p_actor_user_id,'EVIDENCE_REMOVED','case_evidence',p_evidence_id,jsonb_build_object('removal_mode','DRIVE_TRASH','mime_type',v_ev.mime_type,'file_size_bytes',v_ev.file_size_bytes,'reason',left(trim(p_note),2000)));
 return jsonb_build_object('ok',true,'evidenceId',p_evidence_id,'status','REMOVED');
end $function$;

revoke all on function public.evidence_actor_is_authority(uuid,uuid), public.finalize_evidence_upload_atomic(uuid,uuid,uuid,text,text,text,text,boolean), public.review_evidence_atomic(uuid,uuid,uuid,text,text,text), public.quarantine_evidence_atomic(uuid,uuid,uuid,text), public.mark_evidence_removed_atomic(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.evidence_actor_is_authority(uuid,uuid), public.finalize_evidence_upload_atomic(uuid,uuid,uuid,text,text,text,text,boolean), public.review_evidence_atomic(uuid,uuid,uuid,text,text,text), public.quarantine_evidence_atomic(uuid,uuid,uuid,text), public.mark_evidence_removed_atomic(uuid,uuid,uuid,text) to service_role;

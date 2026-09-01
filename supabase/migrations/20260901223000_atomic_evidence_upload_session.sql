create or replace function public.initiate_evidence_upload_atomic(
 p_session_id uuid,p_case_id uuid,p_actor_user_id uuid,p_drive_file_id text,p_drive_folder_id text,
 p_storage_filename text,p_original_filename text,p_mime_type text,p_file_size_bytes bigint,p_sha256_hash text,
 p_uploader_context text,p_access_scope text,p_review_state text,p_expires_at timestamptz,p_max_files integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare v_case public.cases%rowtype; v_active integer; v_pending integer;
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status in ('CLOSED','OUT_OF_SCOPE') then raise exception 'CASE_CLOSED'; end if;
 if p_max_files<1 then raise exception 'INVALID_LIMIT'; end if;
 select count(*) into v_active from public.case_evidence where case_id=p_case_id and status='ACTIVE';
 select count(*) into v_pending from public.case_evidence_upload_sessions where case_id=p_case_id and status='INITIATED' and expires_at>now();
 if v_active+v_pending>=p_max_files then raise exception 'FILE_LIMIT_REACHED'; end if;
 insert into public.case_evidence_upload_sessions(id,case_id,drive_file_id,drive_folder_id,storage_filename,original_filename,mime_type,file_size_bytes,sha256_hash,uploader_context,uploaded_by_user_id,access_scope,review_state,status,expires_at)
 values(p_session_id,p_case_id,p_drive_file_id,p_drive_folder_id,p_storage_filename,p_original_filename,p_mime_type,p_file_size_bytes,p_sha256_hash,p_uploader_context,p_actor_user_id,p_access_scope,p_review_state,'INITIATED',p_expires_at);
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(v_case.organization_id,p_case_id,p_actor_user_id,'EVIDENCE_UPLOAD_INITIATED','case_evidence_upload_session',p_session_id,jsonb_build_object('uploader_context',p_uploader_context,'access_scope',p_access_scope,'mime_type',p_mime_type,'file_size_bytes',p_file_size_bytes));
 return jsonb_build_object('ok',true,'sessionId',p_session_id,'expiresAt',p_expires_at);
end $function$;

create or replace function public.fail_evidence_upload_session_atomic(
 p_session_id uuid,p_case_id uuid,p_actor_user_id uuid,p_uploader_context text,p_final_status text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare v_session public.case_evidence_upload_sessions%rowtype; v_org uuid;
begin
 if p_final_status not in ('FAILED','EXPIRED') then raise exception 'INVALID_STATUS'; end if;
 select * into v_session from public.case_evidence_upload_sessions where id=p_session_id and case_id=p_case_id for update;
 if not found then raise exception 'SESSION_NOT_FOUND'; end if;
 if v_session.uploader_context<>p_uploader_context or v_session.uploaded_by_user_id is distinct from p_actor_user_id then raise exception 'SESSION_FORBIDDEN'; end if;
 if v_session.status in ('FINALIZED','FAILED','EXPIRED') then return jsonb_build_object('ok',true,'status',v_session.status,'alreadyTerminal',true); end if;
 select organization_id into v_org from public.cases where id=p_case_id;
 update public.case_evidence_upload_sessions set status=p_final_status,updated_at=now() where id=p_session_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(v_org,p_case_id,p_actor_user_id,case when p_final_status='EXPIRED' then 'EVIDENCE_UPLOAD_EXPIRED' else 'EVIDENCE_UPLOAD_FAILED' end,'case_evidence_upload_session',p_session_id,jsonb_build_object('reason',left(trim(coalesce(p_reason,'')),500)));
 return jsonb_build_object('ok',true,'status',p_final_status);
end $function$;

revoke all on function public.initiate_evidence_upload_atomic(uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text,timestamptz,integer),public.fail_evidence_upload_session_atomic(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.initiate_evidence_upload_atomic(uuid,uuid,uuid,text,text,text,text,text,bigint,text,text,text,text,timestamptz,integer),public.fail_evidence_upload_session_atomic(uuid,uuid,uuid,text,text,text) to service_role;

const LABEL={UPCOMING:'Upcoming',DUE_SOON:'Due Soon',OVERDUE:'Overdue',COMPLETED:'Completed',CANCELLED:'Cancelled'};
function node(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}

export function renderFollowupMasterDetail(target,rows,{emptyText,renderCard}){
  target.replaceChildren();
  if(!rows.length){target.append(node('div',emptyText,'form-card empty-state'));return;}
  const groups=new Map();
  for(const row of rows){const key=row.case_id||row.public_case_id;if(!groups.has(key))groups.set(key,{key,publicCaseId:row.public_case_id,title:row.title,rows:[]});groups.get(key).rows.push(row);}
  const cases=[...groups.values()];let selected=cases[0].key;
  const layout=node('div',null,'followup-browser'),sidebar=node('aside',null,'followup-case-panel'),mobile=document.createElement('select'),buttons=node('div',null,'followup-case-list'),detail=node('div',null,'followup-case-detail');
  sidebar.append(node('p','Pilih parent case','eyebrow'));mobile.className='followup-case-select';mobile.setAttribute('aria-label','Pilih parent case');
  function paint(){buttons.querySelectorAll('button').forEach(b=>{const active=b.dataset.caseId===selected;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});mobile.value=selected;detail.replaceChildren();const current=groups.get(selected),heading=node('header',null,'followup-case-heading'),copy=node('div');copy.append(node('p','Parent case','eyebrow'),node('h2',current.publicCaseId),node('p',current.title,'muted'));heading.append(copy,node('span',`${current.rows.length} jadwal`,'status-badge'));detail.append(heading);current.rows.forEach(item=>detail.append(renderCard(item)));}
  for(const item of cases){const active=item.rows.filter(r=>['UPCOMING','DUE_SOON','OVERDUE'].includes(r.effective_status)).length,latest=item.rows.find(r=>r.effective_status==='OVERDUE')||item.rows.find(r=>r.effective_status==='DUE_SOON')||item.rows.find(r=>r.effective_status==='UPCOMING')||item.rows[item.rows.length-1],option=document.createElement('option');option.value=item.key;option.textContent=`${item.publicCaseId} — ${item.title||''}`;mobile.append(option);const button=node('button',null,'followup-case-button');button.type='button';button.dataset.caseId=item.key;button.append(node('strong',item.publicCaseId),node('span',item.title||'Tanpa judul','followup-case-title'),node('small',active?`${active} perlu dipantau`:`${item.rows.length} histori · ${LABEL[latest?.effective_status]||latest?.effective_status||'—'}`));button.addEventListener('click',()=>{selected=item.key;paint();});buttons.append(button);}
  mobile.addEventListener('change',()=>{selected=mobile.value;paint();});sidebar.append(mobile,buttons);layout.append(sidebar,detail);target.append(layout);paint();
}

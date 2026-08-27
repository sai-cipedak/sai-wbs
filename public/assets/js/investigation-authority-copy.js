const root=document.querySelector('#workspacePanel')??document.body;
function replaceAuthorityCopy(node){
  const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
  const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
  for(const textNode of nodes){
    if(textNode.nodeValue?.includes('Sekretariat')) textNode.nodeValue=textNode.nodeValue.replaceAll('Sekretariat','Otoritas Kasus');
  }
}
replaceAuthorityCopy(root);
new MutationObserver((mutations)=>{for(const m of mutations){for(const n of m.addedNodes){if(n.nodeType===Node.TEXT_NODE){if(n.nodeValue?.includes('Sekretariat'))n.nodeValue=n.nodeValue.replaceAll('Sekretariat','Otoritas Kasus');}else if(n.nodeType===Node.ELEMENT_NODE)replaceAuthorityCopy(n);}}}).observe(root,{childList:true,subtree:true});

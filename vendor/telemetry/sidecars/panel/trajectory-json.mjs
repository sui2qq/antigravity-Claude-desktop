// Upstream: ATtacK030130/antigrative-dashboard v0.9.1 (MIT License — Copyright (c) 2026 AG Pulse contributors)
// Integrated & adapted for Obsidian Prism under GPL-3.0-only compatibility terms.
// Incremental JSON projection for trajectory RPCs (extended with workspace URI fields for Studio workspace filtering).
import {budgetError} from './collection-state.mjs';
import {normalizeConversationId} from './delegation.mjs';
const scalar='scalar',nonempty='nonempty',presence='presence',calls='calls',guid='conversationId',tokenEstimate='tokenEstimate';
const usage=Object.fromEntries(['inputTokens','outputTokens','responseOutputTokens','thinkingOutputTokens','cacheReadTokens','cacheWriteTokens','apiProvider','responseId','messageId','model'].map(k=>[k,scalar]));
const duration={seconds:scalar,nanos:scalar};
const contextWindowMetadata={estimatedTokensUsed:scalar,maxContextTokens:scalar};
const contextWindowUsage={generatorMetadataIndex:scalar,lastStepIndex:scalar,estimatedTokensUsed:scalar,maxContextTokens:scalar,estimatedAfterCompaction:scalar};
const compactedAtStepIndices={'*':scalar};
const compactionInfo={compactedAtStepIndices};
const generators={'*':{stepIndices:{'*':scalar},chatModel:{usage,model:scalar,modelDisplayName:scalar,responseModel:scalar,
 streamingDuration:duration,timeToFirstToken:duration,retryInfos:{'*':{usage}},
 chatStartMetadata:{createdAt:scalar,startStepIndex:scalar,checkpointIndex:scalar,stepsCoveredByCheckpoint:scalar,contextWindowMetadata}}}};
const subagentResult={conversationId:guid},subagentResults={'*':subagentResult};
const invokeSubagent={conversationId:guid,results:subagentResults};
const checkpoint={checkpointIndex:scalar,intentOnly:scalar,includedStepIndexStart:scalar,includedStepIndexEnd:scalar,
 renderLatestCheckpoint:scalar,modelSummarizationFailed:scalar,usedFallbackSummary:scalar,summaryTokens:scalar,
 sessionSummary:tokenEstimate,userIntent:tokenEstimate,codeChangeSummary:tokenEstimate,memorySummary:tokenEstimate,
 contextWindowMetadata};
const steps={'*':{type:scalar,status:scalar,metadata:{createdAt:duration,startedAt:duration,completedAt:duration,toolCall:presence},
 plannerResponse:{response:nonempty,toolCalls:calls},invokeSubagent,checkpoint}};
const workspaceEntry={workspaceFolderAbsoluteUri:scalar,gitRootAbsoluteUri:scalar,uri:scalar,path:scalar};
const workspaces={'*':workspaceEntry};
const trajectoryMetadata={parentConversationId:guid,rootConversationId:guid,nestingDepth:scalar,workspaces,workspaceUri:scalar};
const summary={summary:scalar,stepCount:scalar,lastModifiedTime:duration,createdTime:duration,status:scalar,lastUserInputStepIndex:scalar,
 hasActiveChildren:scalar,hasRunningSubagents:scalar,notFullyIdle:scalar,trajectoryMetadata,workspaces,workspaceUri:scalar,workspacePath:scalar};
const summaryEntry=Symbol('summaryEntry'),summaries={[summaryEntry]:summary};
const objectOnly=new Set([subagentResult,invokeSubagent,checkpoint,contextWindowMetadata,contextWindowUsage,compactionInfo,workspaceEntry,trajectoryMetadata,summary,summaries]);
const arrayOnly=new Set([subagentResults,compactedAtStepIndices,workspaces]);
const structured=node=>objectOnly.has(node)||arrayOnly.has(node);
const stringAllowed=node=>node===scalar||typeof node==='object'&&!structured(node);
const schema={trajectory:{cascadeId:scalar,trajectoryId:scalar,steps,generatorMetadata:generators,contextWindowUsage,compactedAtStepIndices,compactionInfo},steps,
 generatorMetadata:generators,generatorMetadatas:generators,status:scalar,numTotalSteps:scalar,numTotalGeneratorMetadata:scalar,
 contextWindowUsage,compactedAtStepIndices,compactionInfo,
 trajectorySummaries:summaries};
const DROP=Symbol('discard');
const STR_SPECIAL=/["\\\x00-\x1f]/g;
const LITERAL_CH=/[a-zA-Z0-9+\-.]/;
export class TrajectoryJson {
 constructor({maxRetainedBytes=8*1024*1024,projection=schema,onRecord=null,recordKeys=null}={}){this.maxRetainedBytes=maxRetainedBytes;this.projection=projection;this.onRecord=onRecord;this.recordCounts={steps:0,generatorMetadata:0};this.streamedKinds=new Set();this.recordKeys=recordKeys;this.emitted=0;if(recordKeys&&(!Array.isArray(recordKeys)||recordKeys.length>8||recordKeys.some(k=>typeof k!=='string'||!Object.hasOwn(projection,k))))throw Error('Invalid streamed record keys');}
 stack=[];token=null;result=undefined;done=false;retained=0;
 fail(){throw new Error('Antigravity 接口返回了无法解析的数据');}
 charge(n){if((this.retained+=n)>this.maxRetainedBytes)throw budgetError('retained-fields',this.retained,this.maxRetainedBytes);}
 node(){
  const f=this.stack.at(-1);if(!f)return this.projection;
  if(f.node===summaries)return !f.array&&normalizeConversationId(f.key)?f.node[summaryEntry]:undefined;
  if(objectOnly.has(f.node)&&f.array||arrayOnly.has(f.node)&&!f.array)return undefined;
  const key=f.array?'*':f.key;return f.node&&typeof f.node==='object'&&Object.hasOwn(f.node,key)?f.node[key]:undefined;
 }
 valueAllowed(){const f=this.stack.at(-1);return f?['value','valueOrEnd'].includes(f.expect):!this.done;}
 finishValue(value){
  const f=this.stack.at(-1);
  if(!f){if(this.done)this.fail();this.result=value;this.done=true;return;}
  if(!['value','valueOrEnd'].includes(f.expect))this.fail();
  if(f.streamKind){
   if(value===DROP||!value||typeof value!=='object'||Array.isArray(value))this.fail();
   const index=this.recordCounts[f.streamKind]??0;this.recordCounts[f.streamKind]=index+1;this.emitted++;this.onRecord(f.streamKind,index,value);this.retained=f.baseRetained;
  }else if(value!==DROP&&f.out){this.charge(32+(f.node===summaries?f.key.length*2:0));if(f.array)f.out.push(value);else Object.defineProperty(f.out,f.key,{value,writable:true,enumerable:true,configurable:true});}
  f.count++;f.expect='commaOrEnd';f.key=null;
 }
 punctuation(c){
  const f=this.stack.at(-1);
  if(c==='{'||c==='['){
   if(!this.valueAllowed()||this.stack.length>=64)this.fail();const node=this.node(),array=c==='[';
   const out=typeof node==='object'&&(!objectOnly.has(node)||!array)&&(!arrayOnly.has(node)||array)?(array?[]:{}):null;if(out)this.charge(64);
   let streamKind=null;
   const customKind=this.recordKeys&&f?.node===this.projection&&this.recordKeys.includes(f.key)?f.key:null;
   if(this.onRecord&&(this.recordKeys?customKind:node===steps||node===generators)){
    if(!array)this.fail();streamKind=customKind||(node===steps?'steps':'generatorMetadata');
    if(this.streamedKinds.has(streamKind))this.fail();this.streamedKinds.add(streamKind);
   }
   this.stack.push({node,array,out,count:0,key:null,expect:array?'valueOrEnd':'keyOrEnd',streamKind,baseRetained:this.retained});return;
  }
  if(c==='}'||c===']'){
   if(!f||f.array!==(c===']')||!['commaOrEnd',f.array?'valueOrEnd':'keyOrEnd'].includes(f.expect))this.fail();
   this.stack.pop();this.finishValue(f.node===presence?true:f.node===calls?(f.count?[{}]:[]):f.out||DROP);return;
  }
  if(c===':'){if(!f||f.array||f.expect!=='colon')this.fail();f.expect='value';return;}
  if(c===','){if(!f||f.expect!=='commaOrEnd')this.fail();f.expect=f.array?'value':'key';return;}
  this.fail();
 }
 startString(){
  const f=this.stack.at(-1),key=f&&!f.array&&['key','keyOrEnd'].includes(f.expect);
  if(!key&&!this.valueAllowed())this.fail();
  const node=key?null:this.node();
  const discard=!key&&(node===undefined||node===null);
  this.token={kind:'string',key,node,discard,buffer:'',overflow:false,escape:0,hex:'',hexLen:0,any:false,ascii:0,other:0};
 }
 stringPart(text){
  const t=this.token;if(t.node===nonempty&&/\S/u.test(text)||t.node===presence&&text.length)t.any=true;
  if(t.node==='textEstimate'){
   const other=(text.match(/[^\x00-\x7f]/g)||[]).length;t.ascii+=text.length-other;t.other+=other;
   if(t.buffer.length<256)t.buffer+=text.slice(0,256-t.buffer.length);
  }
  if(t.node===tokenEstimate){
   const other=(text.match(/[^\x00-\x7f]/g)||[]).length;t.ascii+=text.length-other;t.other+=other;
   return;
  }
  if(t.node===guid){if(!t.overflow){if(t.buffer.length+text.length>36){t.buffer='';t.overflow=true;}else t.buffer+=text;}return;}
  if(t.key||stringAllowed(t.node)){
   if(t.overflow)return;t.buffer+=text;
   if(t.buffer.length>(t.key?1024:16384)){if(!t.key)throw budgetError('field',t.buffer.length,16384);t.buffer='';t.overflow=true;}
  }
 }
 endString(){
  const t=this.token;this.token=null;
  if(t.key){const f=this.stack.at(-1);f.key=t.overflow?null:f.node===summaries?normalizeConversationId(t.buffer):t.buffer;f.expect='colon';return;}
  let value=DROP;
  if(t.node===nonempty)value=t.any?'1':'';
  else if(t.node==='textEstimate')value={tokens:Math.ceil(t.ascii/4+t.other/1.5),prefix:t.buffer};
  else if(t.node===tokenEstimate)value=Math.ceil(t.ascii/4+t.other/1.5);
  else if(t.node===presence)value=t.any;
  else if(t.node===guid){const id=!t.overflow&&normalizeConversationId(t.buffer);if(id){value=id;this.charge(value.length*2);}}
  else if(stringAllowed(t.node)){value=t.buffer;this.charge(value.length*2);}
  this.finishValue(value);
 }
 literalEnd(){
  const t=this.token;this.token=null;
  if(!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(t.buffer))this.fail();
  const value=JSON.parse(t.buffer);this.finishValue(t.node&&t.node!==guid&&t.node!==tokenEstimate&&!structured(t.node)?value:DROP);
 }
 write(text,{stopAfterRecord=false}={}){
  let i=0;const before=this.emitted;
  while(i<text.length){
   if(stopAfterRecord&&this.emitted!==before)return i;
   const t=this.token;
   if(t?.kind==='string'){
    if(t.discard){
     if(t.escape===1){
      const cc=text.charCodeAt(i++);
      if(cc===117){t.escape=2;t.hexLen=0;continue;}
      if(cc!==34&&cc!==92&&cc!==47&&cc!==98&&cc!==102&&cc!==110&&cc!==114&&cc!==116)this.fail();
      t.escape=0;continue;
     }
     if(t.escape===2){
      const cc=text.charCodeAt(i++);
      if(!((cc>=48&&cc<=57)||(cc>=65&&cc<=70)||(cc>=97&&cc<=102)))this.fail();
      if(++t.hexLen===4)t.escape=0;
      continue;
     }
     while(i<text.length){
      const cc=text.charCodeAt(i);
      if(cc===34){i++;this.endString();break;}
      if(cc===92){i++;t.escape=1;break;}
      if(cc<32)this.fail();
      i++;
     }
     continue;
    }
    if(t.escape===1){
     const c=text[i++];if(c==='u'){t.escape=2;t.hex='';continue;}
     const decoded={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'}[c];
     if(decoded===undefined)this.fail();this.stringPart(decoded);t.escape=0;continue;
    }
    if(t.escape===2){const c=text[i++];if(!/[0-9a-f]/i.test(c))this.fail();t.hex+=c;if(t.hex.length===4){this.stringPart(String.fromCharCode(parseInt(t.hex,16)));t.escape=0;}continue;}
    STR_SPECIAL.lastIndex=i;const hit=STR_SPECIAL.exec(text),end=hit?hit.index:text.length;
    if(end>i)this.stringPart(text.slice(i,end));i=end;if(!hit)continue;
    const c=text[i++];if(c==='"')this.endString();else if(c==='\\')t.escape=1;else this.fail();continue;
   }
   if(t?.kind==='literal'){
    const start=i;while(i<text.length&&LITERAL_CH.test(text[i]))i++;
    t.buffer+=text.slice(start,i);if(t.buffer.length>1024)this.fail();if(i<text.length)this.literalEnd();continue;
   }
   const cc=text.charCodeAt(i);if(cc===32||cc===10||cc===13||cc===9){i++;continue;}
   const c=text[i++];
   if(c==='"'){this.startString();continue;}
   if('{}[]:,'.includes(c)){this.punctuation(c);continue;}
   if(!this.valueAllowed()||!/[tfn\d-]/.test(c))this.fail();this.token={kind:'literal',node:this.node(),buffer:c};
  }
  return i;
 }
 end(){if(this.token?.kind==='literal')this.literalEnd();if(this.token||this.stack.length||!this.done||!this.result||typeof this.result!=='object')this.fail();if(this.onRecord)this.result.recordCounts={...this.recordCounts};return this.result;}
}

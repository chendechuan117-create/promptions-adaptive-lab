export class Jobs {
  active = new Map();
  versions = new Map();
  begin(clientId, version, requestId, abort) {
    if (version <= (this.versions.get(clientId) ?? -1)) throw new Error('请求已过期，请重新提交');
    this.active.get(clientId)?.abort();
    if (this.active.size>=2 && !this.active.has(clientId)) throw new Error('当前有其他请求，请稍后再试');
    this.versions.set(clientId,version);
    if(this.versions.size>1000) this.versions.delete(this.versions.keys().next().value);
    this.active.set(clientId,{version,requestId,abort});
  }
  isCurrent(clientId,requestId,version) {const job=this.active.get(clientId);return job?.requestId===requestId && job?.version===version;}
  finish(clientId,requestId,version) {if(this.isCurrent(clientId,requestId,version))this.active.delete(clientId);}
  cancel(clientId,requestId,version) {if(this.isCurrent(clientId,requestId,version)){this.active.get(clientId).abort();this.active.delete(clientId);}}
}

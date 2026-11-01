import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RESEARCH_VERSION, POLICY_VERSION, chooseArticles, sourceFingerprint, payloadHash, validateDraft, similarTitle, publisherId, publicURL, stampMessages } from './research-core.mjs';
import { readJSON, writeJSON, ensurePolicy, pause } from './research-runtime.mjs';

export class ResearchEngine {
  constructor({ config, store, feeds, model, client, draftDir, acceptedPolicy, clock = Date.now, sleep = pause, log = console.log, signal }) {
    Object.assign(this, { config, store, feeds, model, client, draftDir: path.resolve(draftDir), acceptedPolicy, clock, sleep, log, signal });
  }
  async locked(operation) {
    const release = this.store.acquire(); let state;
    try {
      state = this.store.read();
      if (state.api && state.api !== this.client.api) throw Error('Research state belongs to another API; use a separate state/identity directory');
      state.api = this.client.api;
      return await operation(state);
    } finally {
      try { if (state) this.store.save(state); } finally { release(); }
    }
  }
  async collect(topic, state) {
    const articles = [], health = [];
    for (const url of topic.feeds) {
      try {
        const value = await this.feeds.read(url, state.cache);
        const accepted = value.articles.filter(s => this.config.publishers.some(p => p.hosts.includes(s.host)));
        articles.push(...accepted);
        health.push({ url, ...value.diagnostics, mapped: accepted.length, cached: value.cached });
        this.log(topic.id + ': ' + new URL(url).hostname + ' → ' + accepted.length + ' artigos; descartes ' + JSON.stringify(value.diagnostics.rejected));
      } catch (error) {
        health.push({ url, error: error.message }); this.log(topic.id + ': feed indisponível — ' + error.message);
      }
    }
    const keywords = (topic.keywords || []).map(k => k.toLowerCase());
    const matches = articles.filter(a => !keywords.length || keywords.some(k => (a.title + ' ' + a.summary).toLowerCase().includes(k)));
    return { articles: matches, health };
  }
  quotas(state, messages = 1, newTopic = true) {
    const recent = this.clock() - 86400000;
    if (newTopic && state.published.filter(p => p.at > recent).length >= this.config.maxPostsPerDay) throw Error('Daily topic limit reached');
    if (state.messages.filter(p => p.at > recent).length + messages > this.config.maxMessagesPerDay) throw Error('Daily message limit reached');
  }
  recordTopic(state, draft, topic) {
    if (!state.published.some(p => p.draftId === draft.id)) {
      const at = Date.parse(topic.createdAt) || this.clock();
      state.published.push({ id: topic.id, draftId: draft.id, fingerprint: draft.fingerprint, at, title: draft.post.title });
      state.topicTimes[draft.theme.id] = at;
      for (const source of draft.sources) state.usedSources[source.url] = { hash: source.contentHash, at };
    }
  }
  recordMessage(state, message) {
    if (!state.messages.some(m => m.id === message.id)) state.messages.push({ id: message.id, at: Date.parse(message.createdAt) || this.clock() });
  }
  saveRejection(topic, sources, depth, error) {
    const file = path.join(this.draftDir, 'diagnostics', 'last-rejected.json');
    const report = { reportVersion: 1, status: 'rejected', createdAt: new Date(this.clock()).toISOString(), api: this.client.api, model: this.model.model, theme: topic.id, depth, error: error.message, sources, attempts: this.model.reviewTrace || [], validationErrors: this.model.validationTrace || [], metrics: this.model.metrics };
    writeJSON(file, report);
    const attempts = report.attempts.map((entry, index) => '## Tentativa ' + (index + 1) + '\n\n' + (entry.message.title ? '### ' + entry.message.title + '\n\n' : '') + entry.message.content + '\n\nRevisão:\n\n```json\n' + JSON.stringify(entry.review || { error: entry.error }, null, 2) + '\n```');
    const invalid = report.validationErrors.length ? '\n\n## Saídas recusadas pela validação\n\n```json\n' + JSON.stringify(report.validationErrors, null, 2) + '\n```' : '';
    fs.writeFileSync(file.replace(/\.json$/, '.md'), '# Pesquisa rejeitada — ' + topic.label + '\n\nRegistro local de diagnóstico; este texto não foi publicado. A próxima rejeição substitui este relatório.\n\nMotivo: ' + error.message + '\n\n' + attempts.join('\n\n---\n\n') + invalid + '\n', { mode: 0o600 });
    return file;
  }
  async generate({ auto = false, topicId, depth = this.config.depth } = {}) {
    if (!['quick', 'balanced', 'deep'].includes(depth)) throw Error('Unknown research depth');
    return this.locked(async state => {
      if (state.pending) {
        if (auto) return this.publishInState(state, state.pending.file, state.pending.hash);
        throw Error('An unfinished publication exists; use research:reconcile or publish the same draft to resume');
      }
      if (auto) this.quotas(state, depth === 'deep' ? 3 : 1);
      if (auto) ensurePolicy(await this.client.request('/api/agent-access/policy'), this.client.api, this.acceptedPolicy);
      const selectedThemes = this.config.topics.filter(t => (!topicId || t.id === topicId) && (!auto || this.clock() - (state.topicTimes[t.id] || 0) >= this.config.topicCooldownHours * 3600000));
      if (topicId && !this.config.topics.some(t => t.id === topicId)) throw Error('Unknown theme: ' + topicId);
      const lastDraft = theme => [...(state.runs || [])].reverse().find(r => r.topicId === theme.id && r.status === 'draft')?.at || 0;
      selectedThemes.sort((a, b) => lastDraft(a) - lastDraft(b));
      const run = { at: this.clock(), status: 'started', feeds: [] }; state.runs.push(run);
      let generationError;
      for (const topic of selectedThemes) {
        const collected = await this.collect(topic, state); run.feeds.push(...collected.health);
        const novel = collected.articles.filter(a => { const old = state.usedSources[a.url]; return !old || (old.hash !== '*' && old.hash !== a.contentHash); });
        const sources = chooseArticles(novel, [], { count: depth === 'quick' ? 2 : this.config.sourcesPerPost, minHosts: 2 });
        if (!sources.length) { this.log(topic.id + ': sem fontes recentes de dois publicadores distintos'); continue; }
        try {
          const built = await this.model.build(topic, sources, { depth });
          const fingerprint = sourceFingerprint(built.sources, topic.id);
          if (state.published.some(p => p.fingerprint === fingerprint || similarTitle(p.title, built.post.title))) { this.log('Pesquisa repetida; tema pulado'); continue; }
          const id = randomBytes(12).toString('hex'), createdAt = new Date(this.clock()).toISOString();
          const messages = stampMessages(built.post, built.replies, id, fingerprint);
          const draft = { schemaVersion: 3, generatorVersion: RESEARCH_VERSION, id, createdAt, status: 'ready', api: this.client.api, policyVersion: POLICY_VERSION, model: this.model.model, depth, theme: { id: topic.id, label: topic.label, tag: topic.tag }, fingerprint, post: messages[0], replies: messages.slice(1), editorial: built.editorial, sources: built.sources, cards: built.cards, plan: built.plan, review: built.review, metrics: built.metrics };
          draft.hash = payloadHash(draft);
          validateDraft(draft, { api: this.client.api, clock: this.clock(), maxAgeHours: this.config.maxDraftAgeHours, maxSourceAgeDays: this.config.maxSourceAgeDays });
          const file = path.join(this.draftDir, id + '.json'); writeJSON(file, draft);
          fs.writeFileSync(path.join(this.draftDir, id + '.md'), '# ' + draft.post.title + '\n\n' + messages.map(m => m.content).join('\n\n---\n\n') + '\n\nSHA-256 do rascunho: `' + draft.hash + '`\n', { mode: 0o600, flag: 'wx' });
          run.status = 'draft'; run.topicId = topic.id; run.file = file; run.hash = draft.hash; run.metrics = built.metrics;
          this.store.save(state);
          if (auto) return this.publishInState(state, file, draft.hash);
          return { status: 'draft', file, markdown: file.replace(/\.json$/, '.md'), hash: draft.hash, messages: messages.length, metrics: built.metrics };
        } catch (error) {
          // Publication failures must retain their pending journal and stop this cycle.
          if (state.pending) throw error;
          generationError = error; run.error = error.message; run.metrics = this.model.metrics; this.log('Pesquisa rejeitada: ' + error.message);
          if (this.model.reviewTrace?.length || this.model.validationTrace?.length) {
            try {
              run.diagnosticFile = this.saveRejection(topic, sources, depth, error);
              this.log('Diagnóstico da rejeição: ' + run.diagnosticFile.replace(/\.json$/, '.md'));
            } catch (reportError) { this.log('Não foi possível salvar o diagnóstico: ' + reportError.message); }
          }
        }
      }
      run.status = generationError ? 'failed' : 'no-new-sources';
      if (generationError) throw generationError;
      return { status: 'no-new-sources', message: 'Nenhum tema elegível com fontes novas suficientes; nenhuma publicação realizada.' };
    });
  }
  async publish(file, expectedHash) { return this.locked(state => this.publishInState(state, file, expectedHash)); }
  async publishInState(state, file, expectedHash) {
    if (this.signal?.aborted) throw Error('Research interrupted');
    const draft = readJSON(file, null);
    if (!expectedHash || draft?.hash !== expectedHash) throw Error('Supply --hash with the SHA-256 of the exact reviewed JSON draft');
    validateDraft(draft, { api: this.client.api, clock: this.clock(), maxAgeHours: this.config.maxDraftAgeHours, maxSourceAgeDays: this.config.maxSourceAgeDays });
    if (!this.config.topics.some(t => t.id === draft.theme.id)) throw Error('Draft theme is not configured');
    for (const source of draft.sources) if (source.publisherId !== publisherId(publicURL(source.feedUrl).hostname, this.config.publishers) || !this.config.publishers.some(p => p.id === source.publisherId)) throw Error('Draft publisher mapping changed; regenerate the draft');
    const policy = await this.client.request('/api/agent-access/policy');
    ensurePolicy(policy, this.client.api, this.acceptedPolicy);
    const idempotent = policy.features?.idempotentWrites === true;
    if (state.published.some(p => p.draftId === draft.id && p.status === 'cancelled') || state.cancelledDrafts?.some(entry => entry.id === draft.id)) throw Error('This draft was cancelled and cannot be sent again');
    if (state.pending && (state.pending.draftId !== draft.id || state.pending.hash !== draft.hash)) throw Error('Another draft has an unfinished publication');
    if (!state.pending) {
      if (state.published.some(p => p.draftId === draft.id)) return { status: 'already-published', topicId: state.published.find(p => p.draftId === draft.id).id };
      const remote = await this.client.request('/api/topics');
      if ((remote.topics || []).some(t => t.content.includes('ref ' + draft.fingerprint.slice(0, 16)) || similarTitle(t.title, draft.post.title))) throw Error('A matching research topic already exists; publication stopped');
      if (this.clock() - (state.topicTimes[draft.theme.id] || 0) < this.config.topicCooldownHours * 3600000) throw Error('Theme cooldown has not elapsed');
      this.quotas(state, 1 + draft.replies.length);
      state.pending = { draftId: draft.id, hash: draft.hash, file: path.resolve(file), startedAt: this.clock(), topicId: null, messages: [draft.post, ...draft.replies].map(() => ({ status: 'ready' })) };
      this.store.save(state);
    }
    const pending = state.pending;
    for (let index = 0; index < pending.messages.length; index++) {
      const message = pending.messages[index]; if (message.status === 'confirmed') continue;
      if (message.status === 'sending' && !idempotent) throw Error('Delivery is uncertain and this Worker lacks idempotent writes. Run research:reconcile before retrying; do not delete the journal.');
      this.quotas(state, 1, index === 0 && !state.published.some(p => p.draftId === draft.id));
      const lastAt = Math.max(0, ...state.messages.map(m => m.at));
      const wait = 21000 - (this.clock() - lastAt);
      if (wait > 0) { this.log('Aguardando o intervalo entre mensagens (' + Math.ceil(wait / 1000) + 's)'); await this.sleep(wait); }
      if (this.signal?.aborted) throw Error('Research interrupted');
      // Authentication itself cannot deliver a forum message.
      if (typeof this.client.session === 'function') await this.client.session();
      message.status = 'sending'; delete message.delivery; delete message.error; this.store.save(state);
      try {
        const route = index === 0 ? '/api/topics' : '/api/topics/' + pending.topicId + '/replies';
        const response = await this.client.authorized(route, { method: 'POST', body: index === 0 ? draft.post : draft.replies[index - 1], idempotencyKey: 'research:' + draft.id + ':' + index });
        const receipt = index === 0 ? response.topic : response.reply;
        if (!receipt?.id || !/^[\w-]{1,80}$/.test(receipt.id)) throw Error('Server did not confirm the message ID');
        message.status = 'confirmed'; message.id = receipt.id;
        if (index === 0) { pending.topicId = receipt.id; this.recordTopic(state, draft, receipt); }
        this.recordMessage(state, receipt); this.store.save(state);
      } catch (error) {
        if (error.delivery === 'not-sent' || [400, 401, 403, 404, 409, 413, 429].includes(error.status)) message.status = 'ready';
        if (error.delivery === 'not-sent') message.delivery = 'not-sent';
        message.error = error.message; this.store.save(state); throw error;
      }
    }
    const topicId = pending.topicId; state.pending = null; this.store.save(state);
    return { status: 'published', topicId, url: 'https://k410sh4.github.io/ai-forum/?topic=' + encodeURIComponent(topicId), messages: 1 + draft.replies.length, hash: draft.hash, idempotentWrites: idempotent };
  }
  async reconcile({ topicId } = {}) {
    return this.locked(async state => {
      const pending = state.pending;
      if (!pending) return { status: 'nothing-pending' };
      const draft = readJSON(pending.file, null);
      if (!draft || draft.hash !== pending.hash || payloadHash(draft) !== pending.hash) throw Error('Pending draft changed; restore the exact JSON from a backup');
      let remoteId = pending.topicId || topicId;
      if (!remoteId) {
        const remote = await this.client.request('/api/topics');
        remoteId = remote.topics?.find(t => t.content === draft.post.content && t.title === draft.post.title)?.id;
      }
      if (!remoteId || !/^[\w-]{1,80}$/.test(remoteId)) throw Error('Delivery remains uncertain. If the topic exists outside the latest 100 results, supply reconcile --topic ID. With idempotent Worker support, publish the same draft/hash to retry safely.');
      const { topic } = await this.client.request('/api/topics/' + remoteId);
      if (!topic || topic.content !== draft.post.content || topic.title !== draft.post.title) throw Error('Remote topic does not match the pending draft');
      pending.topicId = topic.id; pending.messages[0] = { status: 'confirmed', id: topic.id };
      this.recordTopic(state, draft, topic); this.recordMessage(state, topic);
      for (let index = 1; index < pending.messages.length; index++) {
        const reply = topic.replies?.find(r => r.content === draft.replies[index - 1].content && r.authorId === topic.authorId);
        if (reply) { pending.messages[index] = { status: 'confirmed', id: reply.id }; this.recordMessage(state, reply); }
      }
      const complete = pending.messages.every(m => m.status === 'confirmed');
      if (complete) state.pending = null;
      return { status: complete ? 'reconciled' : 'partial', topicId: topic.id, file: pending.file, hash: pending.hash, remaining: pending.messages.filter(m => m.status !== 'confirmed').length };
    });
  }
  async cancel(file, expectedHash) {
    return this.locked(async state => {
      const draft = readJSON(file, null), pending = state.pending;
      if (!pending || !draft || draft.hash !== expectedHash || payloadHash(draft) !== expectedHash || pending.hash !== expectedHash || pending.draftId !== draft.id) throw Error('Cancellation requires the exact pending draft and its hash');
      // In 0.5.3 this exact client error occurred before any publishing request.
      if (!pending.topicId && pending.messages[0]?.status === 'sending' && pending.messages[0].error === 'Untrusted or expired enrollment challenge') {
        pending.messages[0].status = 'ready'; pending.messages[0].delivery = 'not-sent';
      }
      const neverSent = !pending.topicId && pending.messages.every(message => message.status === 'ready');
      if (neverSent) {
        (state.cancelledDrafts ||= []).push({ id: draft.id, at: this.clock(), delivery: 'not-sent' });
        state.runs.push({ at: this.clock(), status: 'cancelled', draftId: draft.id, delivery: 'not-sent', pending });
        state.pending = null;
        return { status: 'cancelled', delivery: 'not-sent', topicId: null, message: 'Tentativa encerrada antes da entrega, sem consumir quotas nem marcar fontes como publicadas.' };
      }
      // Cancellation stops future sends; it does not retract requests already received.
      // Reserve unknown deliveries conservatively and block this fingerprint locally.
      const at = this.clock();
      this.recordTopic(state, draft, { id: pending.topicId || 'uncertain-' + draft.id, createdAt: new Date(at).toISOString() });
      const publication = state.published.find(p => p.draftId === draft.id); publication.status = 'cancelled';
      for (let i = 0; i < pending.messages.length; i++) if (pending.messages[i].status === 'sending') this.recordMessage(state, { id: 'uncertain-' + draft.id + '-' + i, createdAt: new Date(at).toISOString() });
      state.runs.push({ at, status: 'cancelled', topicId: pending.topicId, draftId: draft.id, pending });
      state.pending = null;
      return { status: 'cancelled', topicId: pending.topicId, message: 'Próximos envios interrompidos. Mensagens já recebidas permanecem no fórum; entregas incertas foram reservadas nas quotas.' };
    });
  }
  async doctor() {
    return this.locked(async state => {
      const themes = [];
      for (const topic of this.config.topics) {
        const result = await this.collect(topic, state);
        themes.push({ id: topic.id, articles: result.articles.length, publishers: [...new Set(result.articles.map(a => a.publisherId))], ready: chooseArticles(result.articles).length > 0, feeds: result.health });
      }
      let model, api;
      try { model = await this.model.available(); } catch (error) { model = { available: false, error: error.message }; }
      try {
        const policy = await this.client.request('/api/agent-access/policy');
        ensurePolicy(policy, this.client.api, POLICY_VERSION);
        api = { available: true, idempotentWrites: policy.features?.idempotentWrites === true, policyVersion: policy.policyVersion, accepted: this.acceptedPolicy === policy.policyVersion };
      } catch (error) { api = { available: false, error: error.message }; }
      const warnings = themes.filter(t => !t.ready).map(t => 'Tema sem dois publicadores recentes: ' + t.id);
      if (api.available && !api.idempotentWrites) warnings.push('Worker sem reenvio idempotente: preview disponível; atualize o backend antes de depender da recuperação automática.');
      if (api.available && !api.accepted) warnings.push('Política de participação não aceita nesta sessão: configure FORUM_ACCEPT_POLICY com a versão da política após leitura; preview e doctor não exigem publicação.');
      const usable = model.available && api.available && themes.some(t => t.ready);
      return { status: usable ? (warnings.length ? 'ready-with-warnings' : 'ready') : 'degraded', model, api, warnings, themes, pending: state.pending ? { draftId: state.pending.draftId, topicId: state.pending.topicId } : null };
    });
  }
}

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_TYPE = void 0;
exports.resolveEntityTypeIds = resolveEntityTypeIds;
exports.ingestUser = ingestUser;
exports.ingestAgent = ingestAgent;
exports.recordAgentModel = recordAgentModel;
exports.ingestDiscoveredMcpServers = ingestDiscoveredMcpServers;
exports.isMcpDiscoveryDue = isMcpDiscoveryDue;
exports.recordMcpDiscoveryTriggered = recordMcpDiscoveryTriggered;
exports.isMcpServerKnown = isMcpServerKnown;
exports.isMcpInvokeIngestDue = isMcpInvokeIngestDue;
exports.recordMcpInvokeIngestTriggered = recordMcpInvokeIngestTriggered;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const mcpDiscovery_1 = require("./mcpDiscovery");
// No fallback: only ever writes inside the host-provided plugin data
// directory. Without it, there is nothing honest to write to — every
// change-signature check just always reports "changed," so ingestion is
// simply attempted fresh on every session rather than caching anything.
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'entity-types') : undefined;
}
// Shared across every concurrently-open Copilot session on the machine.
// Worst case on a cold-cache race between two sessions is a harmless
// duplicate GET/POST, not corruption.
function cacheFile(pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    return dir ? path.join(dir, 'catalog.json') : undefined;
}
function loadIngestionCache(pluginDataDir) {
    const file = cacheFile(pluginDataDir);
    if (!file)
        return undefined;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function saveIngestionCache(entry, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(pluginDataDir);
    if (!dir || !file)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        // Merge onto whatever's already cached (entity-type ids and ingested
        // signatures are written independently, at different points in
        // sessionStart.ts's flow) rather than clobbering one with the other.
        const existing = loadIngestionCache(pluginDataDir) || {};
        fs.writeFileSync(file, JSON.stringify({ ...existing, ...entry }), 'utf8');
    }
    catch {
        // best effort — a fetch/ingest just happens again next session
    }
}
// A cached entityTypeId that no longer resolves to a real
// entity type (a policy-store/tenant migration reassigns these ids
// server-side) fails with this specific 404
// body: {"key":"RESOURCE.NOT.FOUND","message":"Entity type not found","data":"<id>"}.
// resolveEntityTypeIds' own cache has no TTL and only ever re-fetches when a
// value is MISSING, never when a present value has gone stale — so without
// this, every ingestion call keeps failing against dead ids indefinitely,
// silently (every caller here treats a failure as best-effort and just
// logs it), until someone manually clears the plugin data dir.
function isEntityTypeNotFoundError(err) {
    return err instanceof Error && err.message.includes('Entity type not found');
}
// Clears the WHOLE local ingestion cache, not just the three entity-type
// ids — it needs to be complete, not partial: after a migration the User
// entity under a freshly-migrated entity-type id can hold only
// {active: true}, none of registeredMachineIds/agents/registeredMcpServers,
// even though this plugin's own knownMcpServerNames still lists several
// MCP servers as already successfully ingested (under the now-dead ids).
// A migration doesn't just reassign entity-type ids, it can leave the data
// empty under the new ones — so knownMcpServerNames is equally stale, and
// clearing only the ids would leave it permanently skipping servers that
// actually need to be re-ingested from scratch, believing they're already
// done. lastMcpDiscoveryTriggeredAt is cleared too, so the very next
// UserPromptSubmit retries immediately rather than waiting out a throttle
// window that's now meaningless. The next resolveEntityTypeIds call (next
// session, or that next throttled recheck) then sees a fully empty cache
// and starts over — this doesn't retry the failed call itself within the
// same pass, but it stops the cache from being permanently stuck on dead
// ids and phantom "already done" entries.
function invalidateStaleIngestionCache(pluginDataDir) {
    saveIngestionCache({
        userEntityTypeId: undefined,
        agentEntityTypeId: undefined,
        mcpServerEntityTypeId: undefined,
        knownMcpServerNames: undefined,
        lastMcpDiscoveryTriggeredAt: undefined,
        lastMcpInvokeIngestAt: undefined,
    }, pluginDataDir);
}
async function ingestionFetch(cfg, url, method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ingestion API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        return await res.json().catch(() => undefined);
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchEntityTypes(cfg) {
    const url = `${cfg.ingestionUrl}/policy-store/entity-types`;
    const raw = await ingestionFetch(cfg, url, 'GET');
    return Array.isArray(raw) ? raw : [];
}
// Resolves the entity-type ids ingestion calls need to pass as
// `entityTypeId`, caching them so a normal session start doesn't cost a
// network round-trip once they're known. Falls back to whatever was already
// cached if a fresh fetch fails.
async function resolveEntityTypeIds(cfg, pluginDataDir, forceRefresh = false) {
    const cached = loadIngestionCache(pluginDataDir);
    // All three must be resolved for the cache to count as fresh — a partial
    // result (e.g. MCPServer missing because it wasn't yet in the catalog on
    // an earlier fetch) keeps retrying on future sessions instead of getting
    // stuck on the same gap forever. The accepted cost: a catalog that
    // genuinely never offers an MCPServer entity type re-fetches on every
    // session rather than caching that absence — one extra lightweight GET,
    // already bounded by ingestionTimeoutMs, not worth more cache complexity
    // to optimize away.
    //
    // forceRefresh (sessionStart.ts, once per session) skips trusting the
    // cache even when it's "complete" — plain and simple proactive refresh,
    // replacing whatever's cached, rather than only reacting after something
    // has already failed against a stale id (see withEntityTypeRetry above
    // for that reactive half, which still matters for callers that don't
    // force-refresh, and for a genuinely new failure mid-session).
    if (!forceRefresh && cached?.userEntityTypeId && cached?.agentEntityTypeId && cached?.mcpServerEntityTypeId) {
        return cached;
    }
    try {
        const types = await fetchEntityTypes(cfg);
        // Matched by name alone — the catalog has exactly one entity
        // type per name (no cross-schema duplicates), so
        // a schemaName filter would be unnecessary complexity. Warn (not
        // fail) if that assumption is ever violated, so a silent misresolution
        // at least leaves a trace under REVA_DEBUG=1.
        for (const name of ['User', 'Agent', 'MCPServer']) {
            const matches = types.filter((t) => t.name === name);
            if (matches.length > 1) {
                (0, debug_1.debugLog)(`resolveEntityTypeIds: multiple entity types named "${name}" — using the first (id=${matches[0].id})`);
            }
        }
        const entry = {
            userEntityTypeId: types.find((t) => t.name === 'User')?.id,
            agentEntityTypeId: types.find((t) => t.name === 'Agent')?.id,
            mcpServerEntityTypeId: types.find((t) => t.name === 'MCPServer')?.id,
        };
        // A freshly-fetched id that DIFFERS from the cached one is a
        // policy-store/tenant migration, detected directly instead of waiting
        // for a failure. Everything derived from the old ids is now meaningless and has
        // to go with them — above all knownMcpServerNames, which lists servers
        // ingested into a store that no longer exists.
        //
        // This gap was created by the proactive force-refresh itself. The
        // reactive half (withEntityTypeRetry -> invalidateStaleIngestionCache)
        // clears the same state, but only when a call actually FAILS with
        // "Entity type not found" — and once ids are refreshed every
        // SessionStart that failure never happens, so the only path that
        // cleared knownMcpServerNames stopped firing. After a
        // migration the cache would hold the new userEntityTypeId and
        // mcpServerEntityTypeId alongside every server name from the old
        // store, so discovery would find N servers, subtract N "known", and make
        // zero calls — permanently. registeredMachineIds and agents came back fine
        // in the same sessions precisely because ingestUser/ingestAgent keep no
        // local cache and re-check live every time.
        //
        // Guarded on the cached value being PRESENT, so a first-ever resolve
        // (nothing cached yet) is not mistaken for a migration.
        const migrated = [
            ['userEntityTypeId', entry.userEntityTypeId],
            ['agentEntityTypeId', entry.agentEntityTypeId],
            ['mcpServerEntityTypeId', entry.mcpServerEntityTypeId],
        ].filter(([field, fresh]) => cached?.[field] && fresh && cached[field] !== fresh);
        if (migrated.length > 0) {
            (0, debug_1.debugLog)(`resolveEntityTypeIds: entity-type ids changed (${migrated
                .map(([field, fresh]) => `${field} ${cached?.[field]} -> ${fresh}`)
                .join('; ')}) — clearing everything derived from the old store`);
            entry.knownMcpServerNames = undefined;
            entry.lastMcpDiscoveryTriggeredAt = undefined;
            entry.lastMcpInvokeIngestAt = undefined;
        }
        saveIngestionCache(entry, pluginDataDir);
        return entry;
    }
    catch {
        return cached || {};
    }
}
// Wraps an ingestion call that depends on a possibly-stale cached
// entityTypeId: on the specific "Entity type not found" failure, invalidates
// the whole local ingestion cache (see invalidateStaleIngestionCache's own
// comment for why that's the full cache, not just this one id) and retries
// ONCE with a freshly-resolved id — recovering within this same pass
// instead of only on the next session or the next throttled recheck. Any
// other failure, or a retry that also fails, is re-thrown so the existing
// caller.catch(...) at each call site keeps logging exactly as before —
// this only adds the retry, it doesn't change how a final failure gets
// reported. Never loops: a genuinely broken backend fails at most twice per
// call, not forever.
async function withEntityTypeRetry(cfg, pluginDataDir, entityTypeId, idField, attempt) {
    try {
        return await attempt(entityTypeId);
    }
    catch (err) {
        if (!isEntityTypeNotFoundError(err))
            throw err;
        invalidateStaleIngestionCache(pluginDataDir);
        const fresh = await resolveEntityTypeIds(cfg, pluginDataDir);
        const freshId = fresh[idField];
        if (!freshId || freshId === entityTypeId)
            throw err; // nothing new to retry with — surface the original failure
        return await attempt(freshId);
    }
}
async function postEntity(cfg, entityTypeId, entityId, attributes) {
    const url = `${cfg.ingestionUrl}/entity?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    await ingestionFetch(cfg, url, 'POST', { entityId, attributes, parents: [], children: [] });
}
// Shape: PATCH /entity/{entityId}?entityTypeId={id}, body
// {attributeValue: {name, value}, op: "ADD", path: "ATTRIBUTE"}. The
// load-bearing use is User.registeredMachineIds — a genuine Set
// (one User can log in from multiple machines), where a plain overwrite
// would let whichever call lands last clobber what an earlier one already
// recorded, so ADD accumulates instead. Also used to update an existing
// Agent's agentType (see ingestAgent() below) — that one is scalar, not a
// Set, but this ADD-op PATCH is the only way this client writes an
// attribute onto an already-existing entity, so it's reused as-is rather
// than inventing a separate "overwrite" shape.
async function addAttributeValue(cfg, entityTypeId, entityId, attribute) {
    const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    await ingestionFetch(cfg, url, 'PATCH', { attributeValue: attribute, op: 'ADD', path: 'ATTRIBUTE' });
}
// Bulk counterpart of postEntity() above, for creating several DIFFERENT
// entities (each with its own entityId) in a single request. Used by
// ingestDiscoveredMcpServers() to create every newly-discovered remote
// server's MCPServer entity in one call instead of one call per server.
async function postEntitiesBulk(cfg, entityTypeId, entities) {
    const url = `${cfg.ingestionUrl}/entity/bulk?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    const body = entities.map(({ entityId, attributes }) => ({ entityId, attributes, parents: [], children: [] }));
    await ingestionFetch(cfg, url, 'POST', body);
}
// Shape:
//   GET {ingestionUrl}/entity/{entityId}?entityTypeId={id}
//   200 -> a full entity record (id/entityAttributes/createdOn/...) — exists
//   404 or 400 -> not found (some backends return 400 rather than a clean
//                 404 for an unresolvable entityId on this lookup)
// Nothing in the 200 body is otherwise inspected — this only answers "does
// this entity already exist," which ingestUser()/ingestAgent() both use to
// decide whether to POST a new one. Generic over entity type/id — the
// mechanics are identical for User and Agent, only which
// entityTypeId/entityId gets passed differs. Any status/error other than a
// clean 200/404/400 is a genuine failure, not a decision either way —
// thrown, not swallowed here, so the caller can choose how to treat
// "inconclusive".
async function entityExists(cfg, entityTypeId, entityId) {
    const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
            },
            signal: controller.signal,
        });
        // 404 is the obvious "not found." 400 is also treated as not-found —
        // some backends return it for an unresolvable entityId on this v1
        // lookup rather than a clean 404, and there's nothing else a 400 on a
        // plain GET-by-id could mean here (no request body to be malformed).
        if (res.status === 404 || res.status === 400)
            return false;
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ingestion GET entity returned HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        return true;
    }
    finally {
        clearTimeout(timer);
    }
}
// "GitHubCopilot" is a constant, not detected — this plugin only ever runs
// inside GitHub Copilot CLI (loaded via its plugin/hooks system). Exported
// since context.ts also sends this as context.agentType on every evaluation
// request, not just ingestion's Agent.agentType.
exports.AGENT_TYPE = 'GitHubCopilot';
// GET-then-branch, every session: entityExists() (GET, above) decides
// whether to POST a new User at all — never re-created if one's already
// there. Not found: a single POST creates the User with `active`,
// registeredMachineIds, AND agents already set — no follow-up PATCH
// needed, since there's nothing to accumulate onto yet on a brand-new
// entity. Found: no POST (never re-created), just two PATCH-ADDs — one for
// registeredMachineIds, one for agents — each on its own, since this
// existing User's Sets may already hold values (a different machine, a
// different account) that must be kept, not overwritten (see
// addAttributeValue). Two separate PATCH calls, not one, because the
// wire shape carries exactly one attributeValue per PATCH — there
// is no way to ADD to two different Set attributes in one call.
// Logging in from the same machine/account twice is a harmless repeat ADD
// either way (Set semantics).
//
// agents links this User back to every Agent (account id) it's associated
// with — a Set, deliberately, since one human could in principle be linked
// to more than one account over time (a re-auth, a second
// account); value is always cfg.agentId, the same id ingestAgent() below
// uses as the Agent entity's own id.
//
// A third Set attribute, registeredMcpServers, also ends up on this same
// User entity — but via ingestDiscoveredMcpServers() below, not here, since
// discovering MCP server names (mcpDiscovery.ts) is that function's job,
// not this one's.
//
// `active` is only ever sent once, in that creation POST, as "false" —
// this plugin has no basis to vouch for the human behind userEmail, and
// never touches `active` again once a User is found to already exist. A
// human/admin verification flow on the Reva side, not this plugin, is
// what's expected to flip active to true.
//
// On an inconclusive existence check (anything other than a clean
// found/not-found — network error, 5xx, timeout), this deliberately does
// NOT guess "not found": erring toward "assume it might already exist,
// don't risk a duplicate/conflicting create" is safer than a wrong POST,
// and the whole check just runs again next session once the underlying
// problem clears. That means an inconclusive check takes the same
// PATCH-only path as "found" — if the User genuinely doesn't exist yet,
// those PATCHes fail harmlessly (logged, not fatal) and the whole thing
// retries next session same as the rest of this file's best-effort calls.
async function ingestUser(cfg, userEntityTypeId, userEmail, 
// The OS's real machine id, or undefined when it could not be read — then
// registeredMachineIds is left untouched rather than given a stand-in.
machineId, agentId, pluginDataDir) {
    const exists = await entityExists(cfg, userEntityTypeId, userEmail).catch((err) => {
        (0, debug_1.debugLog)(`ingestUser: existence check failed (assuming exists, skipping create) — ${err}`);
        return true;
    });
    if (!machineId)
        (0, debug_1.debugLog)('ingestUser: no OS machine id — registeredMachineIds not updated');
    if (!exists) {
        await withEntityTypeRetry(cfg, pluginDataDir, userEntityTypeId, 'userEntityTypeId', (id) => postEntity(cfg, id, userEmail, [
            { name: 'active', value: 'false' },
            ...(machineId ? [{ name: 'registeredMachineIds', value: machineId }] : []),
            { name: 'agents', value: agentId },
        ])).catch((err) => (0, debug_1.debugLog)(`ingestUser: POST failed — ${err}`));
    }
    else {
        if (machineId) {
            await withEntityTypeRetry(cfg, pluginDataDir, userEntityTypeId, 'userEntityTypeId', (id) => addAttributeValue(cfg, id, userEmail, { name: 'registeredMachineIds', value: machineId })).catch((err) => (0, debug_1.debugLog)(`ingestUser: PATCH registeredMachineIds failed — ${err}`));
        }
        await withEntityTypeRetry(cfg, pluginDataDir, userEntityTypeId, 'userEntityTypeId', (id) => addAttributeValue(cfg, id, userEmail, { name: 'agents', value: agentId })).catch((err) => (0, debug_1.debugLog)(`ingestUser: PATCH agents failed — ${err}`));
    }
}
// Same GET-then-branch pattern as ingestUser() above, restructured the same
// way: entityExists() (GET) decides whether to POST a new Agent at all —
// never re-created (with a fresh, possibly-stale `user` attribute) if one's
// already there for this account. Not found: a single POST creates the
// Agent with both `user` and agentType already set — no follow-up PATCH
// needed. Found: no POST, just an update of agentType on its own, via the
// same ADD-op PATCH addAttributeValue() also uses for genuine Sets (see its
// own comment) — the only write-an-attribute shape this client relies on.
//
// agentType is a scalar, not a Set — Agent's id is the Copilot account id
// (see deviceId.ts's resolveAgentId), and from this plugin's own
// perspective that account is always talking to Reva through exactly one
// tool, this one, so there's nothing to accumulate: agentType is always
// AGENT_TYPE ("GitHubCopilot"), full stop.
//
// userEmail here is only ever sent as an ATTRIBUTE VALUE on the Agent
// entity (a reference back to which human this account belongs to) — this
// never creates, updates, or otherwise writes to the User entity itself
// (ingestUser() above does, separately).
//
// Same inconclusive-check handling as ingestUser(): anything other than a
// clean found/not-found (network error, 5xx, timeout) assumes "exists,"
// taking the same PATCH-only path as a genuine "found" rather than risking
// a wrong POST — the whole check just runs again next session. If the
// Agent genuinely doesn't exist yet, that PATCH fails harmlessly (logged,
// not fatal) and retries next session same as the rest of this file's
// best-effort calls.
async function ingestAgent(cfg, agentEntityTypeId, agentId, userEmail, pluginDataDir) {
    const exists = await entityExists(cfg, agentEntityTypeId, agentId).catch((err) => {
        (0, debug_1.debugLog)(`ingestAgent: existence check failed (assuming exists, skipping create) — ${err}`);
        return true;
    });
    if (!exists) {
        await withEntityTypeRetry(cfg, pluginDataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => postEntity(cfg, id, agentId, [
            { name: 'user', value: userEmail },
            { name: 'agentType', value: exports.AGENT_TYPE },
            // The real OS family, captured at session start (windows / macos /
            // linux).
            { name: 'operatingSystems', value: (0, deviceId_1.osFamily)() },
        ])).catch((err) => (0, debug_1.debugLog)(`ingestAgent: POST failed — ${err}`));
    }
    else {
        await withEntityTypeRetry(cfg, pluginDataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => addAttributeValue(cfg, id, agentId, { name: 'agentType', value: exports.AGENT_TYPE })).catch((err) => (0, debug_1.debugLog)(`ingestAgent: PATCH agentType failed — ${err}`));
        // Its own PATCH, so a schema that doesn't declare operatingSystems still
        // records agentType.
        await withEntityTypeRetry(cfg, pluginDataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => addAttributeValue(cfg, id, agentId, { name: 'operatingSystems', value: (0, deviceId_1.osFamily)() })).catch((err) => (0, debug_1.debugLog)(`ingestAgent: PATCH operatingSystems failed (schema may not declare it) — ${err}`));
    }
}
// Agent.models — every model this account has run, PATCH-ADDed as a Set.
// Copilot only knows the concrete
// model once a prompt is routed (session start can precede Auto's choice),
// so this is called from the prompt hook. A per-machine record of models
// already added keeps it to one PATCH per new model rather than one per
// prompt; the record is only written after the PATCH succeeds, so a failure
// is retried on the next prompt. Best-effort: never throws.
function reportedModelsFile(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'agent-models.json') : undefined;
}
function readReportedModels(pluginDataDir) {
    const file = reportedModelsFile(pluginDataDir);
    if (!file)
        return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
async function recordAgentModel(cfg, agentId, model, pluginDataDir) {
    if (!model)
        return;
    try {
        const reported = readReportedModels(pluginDataDir);
        if ((reported[agentId] || []).includes(model))
            return;
        const { agentEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir);
        if (!agentEntityTypeId)
            return;
        await withEntityTypeRetry(cfg, pluginDataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => addAttributeValue(cfg, id, agentId, { name: 'models', value: model }));
        const file = reportedModelsFile(pluginDataDir);
        if (file) {
            reported[agentId] = [...(reported[agentId] || []), model];
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(reported), 'utf8');
        }
        (0, debug_1.debugLog)(`recordAgentModel: added "${model}" to Agent.models`);
    }
    catch (err) {
        (0, debug_1.debugLog)(`recordAgentModel: PATCH models failed (schema may not declare it) — ${err}`);
    }
}
// File-based discovery (mcpDiscovery.ts) — see that module's own comment for
// the sources it reads and the one deliberate exclusion (plugin-bundled
// servers — a scope decision, not a technical limit). Discovery itself is
// just a handful of local file reads, so unlike a CLI shell-out with a
// health check, there's no reason to throttle it — it runs on every
// SessionStart.
// The "known names" cache below still exists, but purely to skip redundant
// POSTs for servers already ingested, not to skip discovery itself.
//
// Every genuinely NEW server name discovered (remote or stdio) is
// PATCH-ADDed onto the User entity as registeredMcpServers — same
// accumulating-Set pattern as registeredMachineIds/agents in ingestUser()
// above — independently of whether it also gets its own MCPServer entity
// below (that needs a baseUrl; registeredMcpServers doesn't). "The user has
// this configured on their machine" and "Reva has a full entity for it"
// are different facts, and a stdio-only server is still genuinely
// configured even though it can't become its own entity. The entity side is
// one bulk POST (postEntitiesBulk) regardless of how many servers were
// found; the registeredMcpServers side is one single-entity PATCH per name,
// because the bulk PATCH silently collapses a Set to a single value (see
// this file's top comment and the note at the call site). Only a pass that
// actually discovered something new makes any call at all.
//
// Known-tracking: a stdio/connector entry (no url) is marked known once its
// registeredMcpServers PATCH is CONFIRMED settled — succeeded, or was never
// attempted at all because the caller passed no userEntityTypeId/userEmail
// (see below) — never on an unconfirmed or failed attempt. Marking known
// regardless of the PATCH's outcome would be wrong: a single failed PATCH
// would permanently hide a real gap, since the entry would be marked known
// anyway and never retried, leaving the connector silently absent from the
// User entity forever. A remote entry follows the same principle: known
// only if the MCPServer POST succeeds. The one real difference bulk
// introduces on that side: since the POST is one atomic call for every
// remote entry in this pass rather than one call per entry, a single
// failure (or a transient blip) holds back known-marking for the whole
// batch, not just the one entry that would have actually failed — an
// inherent consequence of the bulk endpoint's own atomicity (see this
// file's top comment), not a choice made here.
//
// userEntityTypeId/userEmail are optional so a caller that only has
// mcpServerEntityTypeId resolved can still ingest MCPServer entities
// without the User-side PATCH.
async function ingestDiscoveredMcpServers(cfg, mcpServerEntityTypeId, cwd, pluginDataDir, userEntityTypeId, userEmail, discover = mcpDiscovery_1.discoverMcpServers) {
    const cached = loadIngestionCache(pluginDataDir);
    const known = new Set(cached?.knownMcpServerNames || []);
    const newEntries = discover(cwd).filter((entry) => !known.has(entry.name));
    if (newEntries.length === 0)
        return;
    // Whether registeredMcpServers is settled for this pass: true if there
    // was nothing to attempt at all (no userEntityTypeId/userEmail given —
    // this caller never asked for the User-side PATCH), false the moment an
    // attempt is actually made, flipped back to true only on confirmed
    // success. This distinction matters: a stdio/connector
    // entry marked known unconditionally, regardless of
    // whether this PATCH actually succeeded, would mean a single failed PATCH
    // (for any reason — a stale id that even the retry couldn't recover,
    // a transient error) silently and permanently hid a real gap: the entry
    // is marked known locally, never actually present in registeredMcpServers
    // on the real User entity, and never retried again.
    // ONE SINGLE-ENTITY PATCH PER NAME — deliberately not the bulk endpoint.
    // PATCH /entity/bulk does not honour
    // op:"ADD" as a Set append: a single request carrying eight ADD ops for
    // registeredMcpServers returns 200 and leaves the attribute holding exactly
    // ONE value, as though each op overwrote the last. The single endpoint,
    // PATCH /entity/{entityId}, appends correctly:
    // [google-calendar] + ADD gmail -> [google-calendar,gmail],
    // and it is the same call that accumulates
    // registeredMachineIds across machines.
    //
    // With the bulk call the attribute would also appear to oscillate between
    // different subsets of names as overlapping passes each clobbered it.
    //
    // Sequential, not concurrent: the server side is a read-modify-write, so
    // firing these in parallel risks losing values the same way. N names
    // is N small calls, and only on a pass that actually found something
    // new — the common steady-state pass sends nothing at all.
    //
    // postEntitiesBulk below is NOT affected and stays bulk: creating distinct
    // entities has no shared attribute to clobber, so one call creates every
    // MCPServer entity correctly.
    const patchedOk = new Set();
    const userPatchAttempted = Boolean(userEntityTypeId && userEmail);
    if (userEntityTypeId && userEmail) {
        for (const entry of newEntries) {
            try {
                await withEntityTypeRetry(cfg, pluginDataDir, userEntityTypeId, 'userEntityTypeId', (id) => addAttributeValue(cfg, id, userEmail, { name: 'registeredMcpServers', value: entry.name }));
                patchedOk.add(entry.name);
            }
            catch (err) {
                (0, debug_1.debugLog)(`ingestDiscoveredMcpServers: PATCH registeredMcpServers failed for "${entry.name}" — ${err}`);
            }
        }
    }
    // Per-NAME confirmation, rather than one flag covering the whole pass.
    // With individual calls each name's outcome is known exactly, so one
    // failure no longer holds back the others that worked, and — the part that
    // matters — a name whose PATCH failed is never marked known, so the next
    // pass retries precisely it. When no PATCH was attempted at all (caller
    // passed no userEntityTypeId/userEmail) there is genuinely nothing to
    // confirm, which is a deliberate "nothing to do", not a failure.
    const userSideSettled = (name) => !userPatchAttempted || patchedOk.has(name);
    for (const entry of newEntries) {
        // stdio/connector — nothing else to ingest, stop re-checking it, but
        // only once its own User-side PATCH actually succeeded.
        if (!entry.url && userSideSettled(entry.name))
            known.add(entry.name);
    }
    const remoteEntries = newEntries.filter((entry) => entry.url);
    if (remoteEntries.length > 0) {
        try {
            await withEntityTypeRetry(cfg, pluginDataDir, mcpServerEntityTypeId, 'mcpServerEntityTypeId', (id) => postEntitiesBulk(cfg, id, remoteEntries.map((entry) => ({
                entityId: entry.name,
                attributes: [
                    // entityId is the slug; the human-readable name rides in the
                    // description rather than in a displayName attribute of its
                    // own. Deliberate: postEntitiesBulk is atomic, so a single
                    // attribute this tenant's MCPServer schema doesn't declare
                    // would fail the POST for every server in the batch, not just
                    // one. description is known-good. If the schema does declare
                    // displayName, promoting it is a one-line change.
                    {
                        name: 'description',
                        value: entry.displayName ? `MCP server "${entry.displayName}" (${entry.name})` : `MCP server "${entry.name}"`,
                    },
                    { name: 'transport', value: 'http' },
                    { name: 'baseUrl', value: entry.url },
                    { name: 'connectionType', value: 'remote' },
                ],
            }))));
            // Known only if BOTH halves landed: the entity POST above and this
            // name's own registeredMcpServers PATCH. Marking on the POST alone
            // would lose a failed PATCH forever.
            remoteEntries.filter((entry) => userSideSettled(entry.name)).forEach((entry) => known.add(entry.name));
        }
        catch (err) {
            (0, debug_1.debugLog)(`ingestDiscoveredMcpServers: bulk ingest of ${remoteEntries.length} MCPServer entity(ies) failed — will retry next session — ${err}`);
        }
    }
    saveIngestionCache({ knownMcpServerNames: [...known] }, pluginDataDir);
}
const MCP_DISCOVERY_RECHECK_INTERVAL_MS = 15 * 60 * 1000;
// True once MCP_DISCOVERY_RECHECK_INTERVAL_MS has passed since the last
// recorded trigger, or if there's never been one. Global per machine, same
// scoping as knownMcpServerNames above — not scoped per project/cwd, so a
// concurrent session's own recent trigger can push out a different
// project's recheck by a few minutes at worst. Same class of imprecision
// this cache already accepts elsewhere ("harmless duplicate, not
// corruption") — the alternative (a per-cwd keyed cache) is real added
// complexity this doesn't seem to warrant yet.
function isMcpDiscoveryDue(pluginDataDir) {
    const cached = loadIngestionCache(pluginDataDir);
    return Date.now() - (cached?.lastMcpDiscoveryTriggeredAt ?? 0) >= MCP_DISCOVERY_RECHECK_INTERVAL_MS;
}
function recordMcpDiscoveryTriggered(pluginDataDir) {
    saveIngestionCache({ lastMcpDiscoveryTriggeredAt: Date.now() }, pluginDataDir);
}
// Invoke-time ingestion (see authorize.ts). Short window, because this only
// fires for a server that ISN'T already in knownMcpServerNames — the common
// case costs one Set lookup and nothing else. The window exists purely so a
// burst of calls to the same still-unknown server can't each spawn their own
// overlapping child while the first one is still running.
const MCP_INVOKE_INGEST_INTERVAL_MS = 60 * 1000;
function isMcpServerKnown(name, pluginDataDir) {
    const cached = loadIngestionCache(pluginDataDir);
    return (cached?.knownMcpServerNames || []).includes(name);
}
function isMcpInvokeIngestDue(pluginDataDir) {
    const cached = loadIngestionCache(pluginDataDir);
    return Date.now() - (cached?.lastMcpInvokeIngestAt ?? 0) >= MCP_INVOKE_INGEST_INTERVAL_MS;
}
function recordMcpInvokeIngestTriggered(pluginDataDir) {
    saveIngestionCache({ lastMcpInvokeIngestAt: Date.now() }, pluginDataDir);
}

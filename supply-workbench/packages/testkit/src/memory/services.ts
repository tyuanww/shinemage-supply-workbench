import { DEFAULT_SETTINGS } from '@sw/domain';
import type { AuditLog } from '../../../application/src/ports/audit-log.js';
import type { FileStore } from '../../../application/src/ports/file-store.js';
import type { SettingsRepository } from '../../../application/src/ports/settings-repository.js';
import type { UserDirectory } from '../../../application/src/ports/user-directory.js';
import type { UserRepository } from '../../../application/src/ports/user-repository.js';
import type { WeeklyReportRepository } from '../../../application/src/ports/weekly-report-repository.js';
import type { MemoryBox } from './box.js';
import { idRepository } from './repository.js';

export function userRepository(box: MemoryBox): UserRepository {
  const repo = idRepository(() => box.current.users, '用户');
  return {
    ...repo,
    async list() {
      return [...box.current.users.values()];
    },
  };
}

export function settingsRepository(box: MemoryBox): SettingsRepository {
  return {
    async get() {
      return box.current.settings ?? structuredClone(DEFAULT_SETTINGS);
    },
    async save(settings) {
      box.current.settings = settings;
    },
    async saveConditional(settings, expected) {
      const current = box.current.settings ?? structuredClone(DEFAULT_SETTINGS);
      if (!sameSettings(current, expected)) return false;
      box.current.settings = settings;
      return true;
    },
  };
}

function sameSettings(left: import('@sw/domain').Settings, right: import('@sw/domain').Settings): boolean {
  return left.upcomingDays === right.upcomingDays
    && left.shippedNotReceivedAlertDays === right.shippedNotReceivedAlertDays
    && left.deliveryNoteAlertDays === right.deliveryNoteAlertDays
    && left.missingDateHintWindowDays === right.missingDateHintWindowDays
    && left.dateSanityRange.from === right.dateSanityRange.from
    && left.dateSanityRange.to === right.dateSanityRange.to
    && left.ownWarehousePartyId === right.ownWarehousePartyId;
}

export function weeklyReportRepository(box: MemoryBox): WeeklyReportRepository {
  const repo = idRepository(() => box.current.weeklyReports, '周报');
  return {
    ...repo,
    async findCurrent(weekStart) {
      return [...box.current.weeklyReports.values()].find((row) => row.weekStart === weekStart && row.supersededBy === null);
    },
    async list({ page, pageSize }) {
      const all = [...box.current.weeklyReports.values()].sort((left, right) =>
        left.generatedAt < right.generatedAt ? 1 : -1,
      );
      const start = (page - 1) * pageSize;
      return { items: all.slice(start, start + pageSize), total: all.length };
    },
  };
}

export function userDirectory(box: MemoryBox): UserDirectory {
  return {
    async findActive(id) {
      const user = box.current.users.get(id);
      if (user === undefined || !user.active) return undefined;
      return { id: user.id, name: user.name, roles: user.roles };
    },
    async findActiveByFeishuOpenId(openId) {
      const user = [...box.current.users.values()].find((candidate) => candidate.active && candidate.feishuOpenId === openId);
      return user === undefined ? undefined : { id: user.id, name: user.name, roles: user.roles };
    },
    async listDevLoginUsers() {
      return [...box.current.users.values()]
        .filter((user) => user.active)
        .map((user) => ({ id: user.id, name: user.name, roles: user.roles }));
    },
  };
}

export function fileStore(box: MemoryBox): FileStore {
  return {
    async put(input) {
      const sha256 = await sha256Of(input.bytes);
      const existing = box.current.files.get(sha256);
      if (existing !== undefined) return existing.meta;
      const meta = { sha256, originalName: input.originalName, size: input.bytes.byteLength, mime: input.mime };
      box.current.files.set(sha256, { meta, bytes: input.bytes.slice() });
      return meta;
    },
    async read(sha256) {
      return box.current.files.get(sha256)?.bytes;
    },
  };
}

export function auditLog(box: MemoryBox): AuditLog {
  return {
    async record(entry) {
      if (box.transaction.getStore()?.active !== true) throw new Error('审计只能在工作单元里写');
      box.current.audit.push(entry);
    },
    async hasEntry(query) {
      return box.current.audit.some((entry) => entry.entity === query.entity && entry.entityId === query.entityId
        && entry.action === query.action && entry.actorUserId === query.actorUserId);
    },
  };
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

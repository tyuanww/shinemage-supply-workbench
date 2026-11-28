import type { ErrorCode } from '@sw/domain';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor({ code, message, details = {} }: { readonly code: ErrorCode; readonly message: string; readonly details?: Readonly<Record<string, unknown>> | undefined }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = { ...details };
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super({ code: 'NOT_FOUND', message: `${entity}不存在`, details: id === undefined ? { entity } : { entity, id } });
  }
}

export class ForbiddenError extends AppError {
  constructor(action: string) {
    super({ code: 'FORBIDDEN', message: '角色不允许', details: { action } });
  }
}

export class ValidationFailedError extends AppError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super({ code: 'VALIDATION_FAILED', message, details });
  }
}

export class OrderLineLockBusy extends Error {
  readonly lineId: string;

  constructor(lineId: string) {
    super('订单行正在被另一事务更新');
    this.name = 'OrderLineLockBusy';
    this.lineId = lineId;
  }
}

export function isOrderLineLockBusy(error: unknown): error is OrderLineLockBusy {
  return error instanceof Error && error.name === 'OrderLineLockBusy' && 'lineId' in error && typeof error.lineId === 'string';
}

export class StateConflictError extends AppError {
  constructor(state: string) {
    super({ code: 'STATE_CONFLICT', message: '当前状态不允许这个操作', details: { state } });
  }
}

export class UndoWindowExpiredError extends AppError {
  constructor() {
    super({ code: 'UNDO_WINDOW_EXPIRED', message: '超过撤销窗口' });
  }
}

export class UndoNotOwnerError extends AppError {
  constructor() {
    super({ code: 'UNDO_NOT_OWNER', message: '只能撤销自己的记录' });
  }
}

export class FieldOwnedByImportError extends AppError {
  constructor(field: string) {
    super({ code: 'FIELD_OWNED_BY_IMPORT', message: '想改的字段归导入所有', details: { field } });
  }
}

export class DateChangeReasonRequiredError extends AppError {
  constructor() {
    super({ code: 'DATE_CHANGE_REASON_REQUIRED', message: '修改已有确认到货日没写原因' });
  }
}

export class BatchHasRecordsError extends AppError {
  constructor() {
    super({ code: 'BATCH_HAS_RECORDS', message: '批次已有记录，不能删除' });
  }
}

export class ImportTemplateUnknownError extends AppError {
  constructor() {
    super({ code: 'IMPORT_TEMPLATE_UNKNOWN', message: '识别不出模板，也没有手选' });
  }
}

export class ImportFactoryRequiredError extends AppError {
  constructor() {
    super({ code: 'IMPORT_FACTORY_REQUIRED', message: '代工厂模板没选代工厂' });
  }
}

export class ImportNotParsedError extends AppError {
  constructor() {
    super({ code: 'IMPORT_NOT_PARSED', message: '批次不是待确认状态' });
  }
}

export class ImportHasConflictsError extends AppError {
  constructor(count: number) {
    super({ code: 'IMPORT_HAS_CONFLICTS', message: '还有未处理的冲突行', details: { count } });
  }
}

export class RateLimitedError extends AppError {
  constructor() {
    super({ code: 'RATE_LIMITED', message: '登录尝试过多，请稍后再试' });
  }
}

export class ForbiddenPairConfirmRequiredError extends AppError {
  constructor() {
    super({ code: 'FORBIDDEN_PAIR_CONFIRM_REQUIRED', message: '这两个名字属于禁止合并组合，需要二次确认' });
  }
}

export class FeishuNotConfiguredError extends AppError {
  constructor() {
    super({ code: 'FEISHU_NOT_CONFIGURED', message: '没配置飞书应用' });
  }
}

export class FileTooLargeError extends AppError {
  constructor(kind: 'import' | 'attachment') {
    super({ code: 'FILE_TOO_LARGE', message: '超过大小上限', details: { kind } });
  }
}

export class FileTypeNotAllowedError extends AppError {
  constructor() {
    super({ code: 'FILE_TYPE_NOT_ALLOWED', message: '文件类型不允许' });
  }
}

export class WorkbookUnreadableError extends ValidationFailedError {
  constructor(cause?: unknown) {
    super('无法解析文件。请更换文件，或从原系统重新导出 XLSX 后再上传。', { reason: 'file_unreadable' });
    this.cause = cause;
  }
}

export class UnauthenticatedError extends AppError {
  constructor() {
    super({ code: 'UNAUTHENTICATED', message: '没登录或会话过期' });
  }
}

export class InternalError extends AppError {
  constructor(message = '内部错误') {
    super({ code: 'INTERNAL', message });
  }
}

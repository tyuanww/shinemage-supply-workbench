import type { RejectCodeLink, RejectCodeLinkDeps } from '../boundary.js';
import { auditOf } from '../../shared/audit.js';
import { authorize } from '../../shared/authorize.js';
import { refreshLineProjection } from '../../shared/line-projection.js';
import { prepareCodeRelink, relinkPreparedRows } from './relink-rows.js';
import { reviewed } from './reviewed.js';

export const makeRejectCodeLink =
  (deps: RejectCodeLinkDeps): RejectCodeLink =>
  async (input, actor) => {
    authorize(actor, 'master.review');
    const at = deps.clock.now();
    await deps.uow.run(async (tx) => {
      const link = await tx.codeLinks.get(input.linkId);
      const left = await tx.itemCodes.get(link.fromCodeId);
      const right = await tx.itemCodes.get(link.toCodeId);
      const after = reviewed(link, { actorId: actor.id, at, status: 'rejected' });
      await tx.codeLinks.save(after);
      const rows = await prepareCodeRelink(tx, [left.codeNorm, right.codeNorm]);
      const lineIds = await relinkPreparedRows(tx, rows);
      if (lineIds.length > 0) await refreshLineProjection(tx, lineIds);
      await tx.audit.record(auditOf({ action: 'code-link.reject', subject: after, ctx: { actor, at, before: link, after, entity: '编码对照' } }));
    });
    return { linkId: input.linkId };
  };

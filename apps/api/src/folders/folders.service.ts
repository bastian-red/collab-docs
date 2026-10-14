/**
 * Folders: a tree stored in a self-referencing column, and the two ways that
 * goes wrong.
 *
 * Neither rule is written here. `CHECK ("id" <> "parent_id")` stops the one-node
 * cycle in the database, and `services/doc-access` owns the rest --
 * `ancestryOf` walks the chain with its own bound, `assertFolderMove` refuses a
 * move into a folder's own subtree and caps the depth. This service is the
 * Prisma half: the lookups those functions need, inside the transaction that has
 * to see a consistent tree.
 */
import { Injectable } from '@nestjs/common';
import { FOLDER_MAX_DEPTH, ancestryOf, assertFolderMove, depthUnder } from '@docs/doc-access';
import { DomainError } from '@docs/shared';

import { PrismaService } from '../infra/prisma.service';
import { presentFolder, type FolderWire } from '../documents/presenters';

const FOLDER_SELECT = {
  id: true,
  name: true,
  parentId: true,
  // Only the documents still there. A folder reporting four documents that opens
  // onto one is a bug report every time, and `deleted_at` is the difference.
  _count: { select: { documents: { where: { deletedAt: null } } } },
} as const;

@Injectable()
export class FoldersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A person's own folders.
   *
   * Folders belong to one person and are not shared -- a document shared with
   * you appears in your list at the root, filed wherever you file it. Sharing a
   * folder would mean a document in two trees at once, which is a different
   * product.
   */
  async list(userId: string): Promise<FolderWire[]> {
    const rows = await this.prisma.client.folder.findMany({
      where: { ownerId: userId },
      select: FOLDER_SELECT,
      orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
    });
    return rows.map(presentFolder);
  }

  async create(
    userId: string,
    input: { name: string; parentId: string | null },
  ): Promise<FolderWire> {
    if (input.parentId !== null) {
      // Only the depth half of the move rule applies: a folder that does not
      // exist yet cannot be its own ancestor, so `assertFolderMove` would be
      // asking a vacuous question with an id that is not in the tree.
      const ancestry = await this.ancestry(input.parentId, userId);
      if (depthUnder(ancestry) > FOLDER_MAX_DEPTH) {
        throw new DomainError('INVALID', `Folders nest ${FOLDER_MAX_DEPTH} levels deep at most`);
      }
    }

    const row = await this.prisma.client.folder.create({
      data: { name: input.name, ownerId: userId, parentId: input.parentId },
      select: FOLDER_SELECT,
    });
    return presentFolder(row);
  }

  async rename(folderId: string, userId: string, name: string): Promise<FolderWire> {
    await this.assertOwn(folderId, userId);
    const row = await this.prisma.client.folder.update({
      where: { id: folderId },
      data: { name },
      select: FOLDER_SELECT,
    });
    return presentFolder(row);
  }

  /**
   * Move a folder, or lift it to the root.
   *
   * The ancestry walk and the move check run inside the transaction that does
   * the update, so a concurrent move cannot slip a cycle in between the read and
   * the write. Outside a transaction this is the textbook time-of-check bug, and
   * the symptom is a breadcrumb walk that never terminates.
   */
  async move(folderId: string, userId: string, parentId: string | null): Promise<FolderWire> {
    return this.prisma.client.$transaction(async (tx) => {
      const own = await tx.folder.count({ where: { id: folderId, ownerId: userId } });
      if (own === 0) throw new DomainError('NOT_FOUND', 'Folder not found');

      if (parentId !== null) {
        const parentOwn = await tx.folder.count({ where: { id: parentId, ownerId: userId } });
        if (parentOwn === 0) throw new DomainError('NOT_FOUND', 'Folder not found');

        const ancestry = await ancestryOf(parentId, async (id) =>
          tx.folder.findUnique({ where: { id }, select: { id: true, parentId: true } }),
        );
        assertFolderMove(folderId, ancestry);
      }

      const row = await tx.folder.update({
        where: { id: folderId },
        data: { parentId },
        select: FOLDER_SELECT,
      });
      return presentFolder(row);
    });
  }

  /**
   * Delete a folder.
   *
   * The documents in it are **not** deleted: `folder_id` is `ON DELETE SET NULL`,
   * so they move to the root. Cascading would mean one click destroying every
   * document somebody had filed, including ones other people are editing right
   * now. Child folders do cascade, because a folder with no parent and no
   * ancestor is unreachable rather than at the root.
   */
  async remove(folderId: string, userId: string): Promise<{ id: string }> {
    await this.assertOwn(folderId, userId);
    await this.prisma.client.folder.delete({ where: { id: folderId } });
    return { id: folderId };
  }

  private async ancestry(folderId: string, userId: string): Promise<string[]> {
    await this.assertOwn(folderId, userId);
    return ancestryOf(folderId, async (id) =>
      this.prisma.client.folder.findUnique({ where: { id }, select: { id: true, parentId: true } }),
    );
  }

  /** `NOT_FOUND` for somebody else's folder: ids are guessable and 403-versus-404 is a listing. */
  private async assertOwn(folderId: string, userId: string): Promise<void> {
    const count = await this.prisma.client.folder.count({
      where: { id: folderId, ownerId: userId },
    });
    if (count === 0) throw new DomainError('NOT_FOUND', 'Folder not found');
  }
}

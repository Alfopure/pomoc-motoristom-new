import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Operation, OperationsWorkspace } from '@/domain/operations';
import { TowingError } from '@/server/towing/http';

const mocks = vi.hoisted(() => ({ workspace: vi.fn(), admin: vi.fn(), from: vi.fn(), upload: vi.fn(), download: vi.fn() }));
vi.mock('./index', () => ({ getOperationsWorkspace: mocks.workspace }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: mocks.admin }));
import { downloadOperationFile, uploadOperationFile } from './files';
import { GET, POST } from '@/app/api/operations/[id]/files/route';

const operationId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const reference = `${organizationId}/${operationId}/${fileId}.png`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function workspace(): OperationsWorkspace {
  const operation: Operation = { id: operationId, kind: 'delivery', status: 'assigned', revision: 1, assignmentGeneration: 1, caseId: null, caseNumber: null, fleetAssetId: null, vehicle: null, from: 'Synthetic origin', to: 'Synthetic destination', scheduledAt: null, plannedEndAt: null, confirmedAt: null, startedAt: null, assigneeId: 'synthetic-member', assignee: 'Synthetic member', cycleId: null, owner: 'logistics', ownerId: operationId, evidenceState: 'pending', cycle: null, evidence: [{ id: fileId, stage: 'handover', authorUserId: 'synthetic-user', observedAt: '2026-10-26T10:00:00Z', source: 'observed', person: 'Synthetic person', note: '', photoReference: reference, odometer: null, fuel: null, missingReason: null }], updatedAt: '2026-10-26T10:00:00Z' };
  return { actor: { userId: 'synthetic-user', organizationId, displayName: 'Synthetic member', profileId: null, memberId: 'synthetic-member', version: 1, canDispatch: false }, operations: [operation], totalCount: 1, members: [], fleet: [] };
}
const uploadRequest = (body: BodyInit = png, headers: Record<string, string> = { 'content-type': 'image/png' }) => new Request('https://app.example/api/operations/files', { method: 'POST', headers, body });
const context = { params: Promise.resolve({ id: operationId }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockResolvedValue(workspace());
  mocks.admin.mockReturnValue({ storage: { from: mocks.from } });
  mocks.from.mockReturnValue({ upload: mocks.upload, download: mocks.download });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.download.mockResolvedValue({ data: new Blob([png], { type: 'image/png' }), error: null });
});

describe('private operation evidence access', () => {
  it('does not touch storage when current assignment is absent from the authorized workspace', async () => {
    mocks.workspace.mockResolvedValue({ ...workspace(), operations: [] });
    await expect(downloadOperationFile(operationId, reference)).rejects.toMatchObject({ status: 404 });
    await expect(uploadOperationFile(operationId, uploadRequest())).rejects.toMatchObject({ status: 404 });
    expect(mocks.workspace).toHaveBeenCalledWith({ id: operationId });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('does not expose an unrelated towing operation through shared evidence', async () => {
    const data = workspace(); data.operations[0].owner = 'towing_order'; mocks.workspace.mockResolvedValue(data);
    await expect(downloadOperationFile(operationId, reference)).rejects.toMatchObject({ status: 404 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('allows current office evidence for an explicitly linked towing return', async () => {
    const data = workspace(); data.actor.canDispatch = true;
    data.operations[0].owner = 'towing_order'; data.operations[0].cycleId = '44444444-4444-4444-8444-444444444444';
    mocks.workspace.mockResolvedValue(data);
    await expect(uploadOperationFile(operationId, uploadRequest())).resolves.toHaveProperty('reference');
    await expect(downloadOperationFile(operationId, reference)).resolves.toBeInstanceOf(Response);
  });
  it('keeps field access out of towing return inspection evidence', async () => {
    const data = workspace(); data.operations[0].owner = 'towing_order'; data.operations[0].cycleId = '44444444-4444-4444-8444-444444444444';
    mocks.workspace.mockResolvedValue(data);
    await expect(uploadOperationFile(operationId, uploadRequest())).rejects.toMatchObject({ status: 404 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([
    `foreign-organization/${operationId}/${fileId}.png`,
    `${organizationId}/44444444-4444-4444-8444-444444444444/${fileId}.png`,
    `${organizationId}/${operationId}/../${fileId}.png`,
    `${organizationId}/${operationId}/55555555-5555-4555-8555-555555555555.png`,
    `${organizationId}/${operationId}/${fileId}.svg`,
  ])('rejects foreign, unsafe, or unlinked paths before storage: %s', async path => {
    await expect(downloadOperationFile(operationId, path)).rejects.toMatchObject({ status: 404 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('does not release downloaded bytes when membership is revoked during storage IO', async () => {
    mocks.workspace.mockResolvedValueOnce(workspace()).mockRejectedValueOnce(new TowingError('access_denied', 403, 'Revoked'));
    const response = await GET(new Request(`https://app.example/api/operations/${operationId}/files?reference=${encodeURIComponent(reference)}`), context);
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(reference);
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'access_denied' });
  });
  it('does not confirm an uploaded reference after assignment is removed during storage IO', async () => {
    mocks.workspace.mockResolvedValueOnce(workspace()).mockResolvedValueOnce({ ...workspace(), operations: [] });
    await expect(uploadOperationFile(operationId, uploadRequest())).rejects.toMatchObject({ status: 404 });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
  });
  it('requires dispatch authority to add files after physical completion', async () => {
    const data = workspace(); data.operations[0].status = 'completed'; mocks.workspace.mockResolvedValue(data);
    await expect(uploadOperationFile(operationId, uploadRequest())).rejects.toMatchObject({ status: 403 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('returns only a linked attachment with private download and content isolation headers', async () => {
    const response = await GET(new Request(`https://app.example/api/operations/${operationId}/files?reference=${encodeURIComponent(reference)}`), context);
    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith('motorist-operation-evidence');
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="doklad-jazdy.png"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });
});

describe('operation evidence upload boundary', () => {
  it('rejects unsupported MIME and mismatching bytes before storage', async () => {
    await expect(uploadOperationFile(operationId, uploadRequest('<svg/>', { 'content-type': 'image/svg+xml' }))).rejects.toMatchObject({ status: 415 });
    await expect(uploadOperationFile(operationId, uploadRequest('not a PNG'))).rejects.toMatchObject({ status: 400 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('enforces the byte limit both from Content-Length and on the actual stream', async () => {
    await expect(uploadOperationFile(operationId, uploadRequest(png, { 'content-type': 'image/png', 'content-length': String(4 * 1024 * 1024 + 1) }))).rejects.toMatchObject({ status: 413 });
    await expect(uploadOperationFile(operationId, uploadRequest('x'.repeat(4 * 1024 * 1024 + 1), { 'content-type': 'image/png', 'content-length': '1' }))).rejects.toMatchObject({ status: 413 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('stores valid content under a server-owned organization/operation path without overwrite', async () => {
    const result = await uploadOperationFile(operationId, uploadRequest());
    expect(result.reference).toMatch(new RegExp(`^${organizationId}/${operationId}/[0-9a-f-]{36}\\.png$`));
    expect(mocks.upload).toHaveBeenCalledWith(result.reference, Buffer.from(png), { contentType: 'image/png', upsert: false });
    expect(mocks.workspace).toHaveBeenCalledTimes(2);
  });
  it('rejects cross-origin mutations before resolving access or contacting storage', async () => {
    const request = uploadRequest(png, { 'content-type': 'image/png', origin: 'https://other.example' });
    const response = await POST(request, context);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'origin_rejected' });
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

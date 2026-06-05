import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Form, Modal, Input, message, Select, Space, Table, Tag, Tooltip,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { AxiosError } from 'axios';
import type { ColumnsType } from 'antd/es/table';
import {
  getRootPrefixes, getSubnetTree, mergeSubnets, splitSubnet, updateSubnet,
  getGroups, getIPAMTypes, getVRFs,
} from '../../../api/ipam';
import type { RootPrefix, SubnetNode, IPAMGroup, IPAMType, IPAMVRF } from '../../../types/ipam';
import { useT } from '../../../i18n';
import { cidrMatchesSearch } from '../../../utils/cidr';

// ─── Types ────────────────────────────────────────────────────────────────────

interface UINode {
  key:         string;
  id:          number;
  cidr:        string;
  level:       string;
  target_type: 'root' | 'subnet';
  is_v4:       boolean;
  children?:   UINode[];
  _loading?:   boolean;
  group_id?:   number | null;
  group?:      { id: number; name: string } | null;
  type_id?:    number | null;
  type?:       { id: number; name: string } | null;
  vrf_id?:     number | null;
  vrf?:        { id: number; name: string; rd?: string } | null;
  remark?:     string;
}

interface Props { onCount?: (n: number) => void; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapSubnets(subnets: SubnetNode[], is_v4: boolean): UINode[] {
  return subnets.map((s): UINode => ({
    key:         `subnet-${s.id}`,
    id:          s.id,
    cidr:        s.cidr,
    level:       s.level,
    target_type: 'subnet',
    is_v4,
    group_id:    s.group_id,  group:  s.group  ?? null,
    type_id:     s.type_id,   type:   s.type   ?? null,
    vrf_id:      s.vrf_id,    vrf:    s.vrf    ?? null,
    remark:      s.remark ?? '',
    children:    s.children?.length ? mapSubnets(s.children, is_v4) : undefined,
  }));
}

function filterTree(
  nodes: UINode[],
  cidr: string,
  groupId?: number,
  typeId?: number,
  vrfId?: number,
): UINode[] {
  return nodes.reduce<UINode[]>((acc, n) => {
    const fc = filterTree(n.children ?? [], cidr, groupId, typeId, vrfId);
    const match =
      (!cidr    || cidrMatchesSearch(n.cidr, cidr)) &&
      (!groupId || n.group_id === groupId) &&
      (!typeId  || n.type_id  === typeId)  &&
      (!vrfId   || n.vrf_id   === vrfId);
    if (match || fc.length > 0) {
      acc.push({ ...n, children: fc.length ? fc : n.children });
    }
    return acc;
  }, []);
}

// ─── Component ────────────────────────────────────────────────────────────────

const TabSubnetTree: React.FC<Props> = ({ onCount }) => {
  const t = useT();

  const [roots, setRoots]       = useState<RootPrefix[]>([]);
  const [treeData, setTreeData] = useState<UINode[]>([]);
  const [loading, setLoading]   = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  // Per-field filters
  const [filterCIDR,    setFilterCIDR]    = useState('');
  const [filterGroupId, setFilterGroupId] = useState<number | undefined>();
  const [filterTypeId,  setFilterTypeId]  = useState<number | undefined>();
  const [filterVrfId,   setFilterVrfId]   = useState<number | undefined>();

  const [groups, setGroups] = useState<IPAMGroup[]>([]);
  const [types,  setTypes]  = useState<IPAMType[]>([]);
  const [vrfs,   setVRFs]   = useState<IPAMVRF[]>([]);

  const [splitOpen, setSplitOpen] = useState(false);
  const [splitNode, setSplitNode] = useState<UINode | null>(null);
  const [splitForm]               = Form.useForm();

  const [mergeOpen, setMergeOpen]         = useState(false);
  const [mergeParent, setMergeParent]     = useState<UINode | null>(null);
  const [mergeSelected, setMergeSelected] = useState<React.Key[]>([]);

  const [editOpen, setEditOpen] = useState(false);
  const [editNode, setEditNode] = useState<UINode | null>(null);
  const [editForm]              = Form.useForm();

  // ── Initial load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await getRootPrefixes();
        setRoots(res.data);
        const initial: UINode[] = res.data.map((r) => ({
          key: `root-${r.id}`, id: r.id, cidr: r.cidr,
          level: 'Root', target_type: 'root' as const, is_v4: r.ip_version === 4,
          group_id: r.group_id, group: r.group  ?? null,
          type_id:  r.type_id,  type:  r.type   ?? null,
          vrf_id:   r.vrf_id,   vrf:   r.vrf    ?? null,
          remark:   r.remark ?? '',
          children: [],
        }));
        setTreeData(initial);
        onCount?.(initial.length);
      } catch {
        message.error('Failed to load root prefixes');
      } finally {
        setLoading(false);
      }
    })();
    Promise.all([getGroups(), getIPAMTypes(), getVRFs()]).then(([g, tp, v]) => {
      setGroups(g.data); setTypes(tp.data); setVRFs(v.data);
    }).catch(() => {});
  }, []);

  // ── Reload subtree ────────────────────────────────────────────────────────────
  const reloadRootSubtree = useCallback(async (rootId: number, expandKey?: string) => {
    const root = roots.find((r) => r.id === rootId);
    if (!root) return;
    const res = await getSubnetTree(rootId);
    const children = mapSubnets(res.data, root.ip_version === 4);
    setTreeData((prev) =>
      prev.map((n) =>
        n.id === rootId && n.target_type === 'root'
          ? { ...n, _loading: false, children }
          : n,
      ),
    );
    setExpandedKeys((prev) => {
      const toAdd = new Set<string>([`root-${rootId}`]);
      if (expandKey) toAdd.add(expandKey);
      return Array.from(new Set([...prev, ...toAdd]));
    });
  }, [roots]);

  // ── Lazy-load expand ──────────────────────────────────────────────────────────
  const handleExpand = async (expanded: boolean, record: UINode) => {
    if (!expanded) {
      setExpandedKeys((prev) => prev.filter((k) => k !== record.key));
      return;
    }
    setExpandedKeys((prev) => Array.from(new Set([...prev, record.key])));
    if (record.target_type === 'root') {
      const current = treeData.find((n) => n.key === record.key);
      if (current && current.children?.length === 0) {
        setTreeData((prev) =>
          prev.map((n) => n.key === record.key ? { ...n, _loading: true } : n),
        );
        try { await reloadRootSubtree(record.id); }
        catch {
          message.error('Failed to load subnets');
          setTreeData((prev) =>
            prev.map((n) => n.key === record.key ? { ...n, _loading: false } : n),
          );
        }
      }
    }
  };

  // ── Split ─────────────────────────────────────────────────────────────────────
  const maskOptions = (() => {
    if (!splitNode) return [];
    const [, bStr] = splitNode.cidr.split('/');
    const cur = parseInt(bStr, 10);
    const max = splitNode.is_v4 ? 32 : 128;
    const opts = [];
    for (let i = cur + 1; i <= max && i - cur <= 16; i++) {
      opts.push({ value: i, label: `/${i}  (${t('ipam.subnet.generates', { n: 1 << (i - cur) })})` });
    }
    return opts;
  })();

  const openSplit = (node: UINode) => { setSplitNode(node); splitForm.resetFields(); setSplitOpen(true); };

  const handleSplitSubmit = async () => {
    if (!splitNode) return;
    let v: { target_bits: number };
    try { v = await splitForm.validateFields(); } catch { return; }
    try {
      await splitSubnet({ target_type: splitNode.target_type, target_id: splitNode.id, target_bits: v.target_bits });
      message.success(t('ipam.subnet.splitOk'));
      setSplitOpen(false);
      const root = findRootId(treeData, splitNode.key);
      if (root) await reloadRootSubtree(root, splitNode.key);
    } catch (err: unknown) {
      if (err instanceof AxiosError && err.response?.data?.error)
        Modal.error({ title: 'Split rejected', content: err.response.data.error });
      else message.error('Split failed');
    }
  };

  // ── Merge ─────────────────────────────────────────────────────────────────────
  const openMerge = (node: UINode) => { setMergeParent(node); setMergeSelected([]); setMergeOpen(true); };

  const handleMergeSubmit = async () => {
    if (mergeSelected.length < 2) { message.warning('Select at least 2 subnets'); return; }
    try {
      const ids = (mergeSelected as string[]).map((k) => parseInt(k.split('-').pop()!, 10));
      await mergeSubnets({ subnet_ids: ids });
      message.success(t('ipam.subnet.mergeOk'));
      setMergeOpen(false);
      const root = mergeParent ? findRootId(treeData, mergeParent.key) : undefined;
      if (root) await reloadRootSubtree(root, mergeParent?.key);
    } catch (err: unknown) {
      if (err instanceof AxiosError && err.response?.data?.error)
        Modal.error({ title: 'Merge rejected', content: err.response.data.error });
      else message.error('Merge failed');
    }
  };

  // ── Edit subnet ───────────────────────────────────────────────────────────────
  const openEdit = (node: UINode) => {
    setEditNode(node);
    editForm.setFieldsValue({
      group_id: node.group_id ?? undefined,
      type_id:  node.type_id  ?? undefined,
      vrf_id:   node.vrf_id   ?? undefined,
      remark:   node.remark   ?? '',
    });
    setEditOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editNode) return;
    const v = await editForm.validateFields();
    try {
      await updateSubnet(editNode.id, {
        group_id: v.group_id ?? null, type_id: v.type_id ?? null,
        vrf_id: v.vrf_id ?? null, remark: v.remark ?? '',
      });
      message.success(t('ipam.subnet.saveOk'));
      setEditOpen(false);
      const root = findRootId(treeData, editNode.key);
      if (root) await reloadRootSubtree(root);
    } catch {
      message.error('Update failed');
    }
  };

  // ─── Columns ─────────────────────────────────────────────────────────────────
  const groupOpts = groups.map((g)  => ({ value: g.id,  label: g.name }));
  const typeOpts  = types.map((tp)  => ({ value: tp.id, label: tp.name }));
  const vrfOpts   = vrfs.map((v)    => ({ value: v.id,  label: v.rd ? `${v.name} (${v.rd})` : v.name }));

  const columns: ColumnsType<UINode> = [
    {
      title: t('ipam.root.cidr'), dataIndex: 'cidr', key: 'cidr', width: 200,
      render: (v: string, r: UINode) =>
        r.level === 'Root' ? <strong style={{ fontSize: 15 }}>{v}</strong> : v,
    },
    {
      title: t('ipam.subnet.level'), dataIndex: 'level', key: 'level', width: 65,
      render: (l: string) => (
        <Tag color={l === 'Root' ? 'purple' : l === 'L1' ? 'blue' : 'cyan'}>{l}</Tag>
      ),
    },
    { title: t('ipam.root.group'), key: 'group', width: 120, render: (_, r) => r.group?.name || '—' },
    { title: t('ipam.root.type'),  key: 'type',  width: 120, render: (_, r) => r.type?.name  || '—' },
    {
      title: t('ipam.root.vrf'), key: 'vrf', width: 140,
      render: (_, r) => r.vrf ? `${r.vrf.name}${r.vrf.rd ? ` (${r.vrf.rd})` : ''}` : '—',
    },
    {
      title: t('ipam.root.remark'), key: 'remark', width: 160, ellipsis: true,
      render: (_, r) => r.remark
        ? <Tooltip title={r.remark}>{r.remark}</Tooltip>
        : '—',
    },
    {
      title: t('common.actions'), key: 'action', width: 200, fixed: 'right',
      render: (_: unknown, r: UINode) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => openSplit(r)}>
            {r.children?.length ? t('ipam.subnet.overSplit') : t('ipam.subnet.split')}
          </Button>
          {r.children && r.children.length > 0 && (
            <Button type="link" size="small" onClick={() => openMerge(r)}>
              {t('ipam.subnet.merge')}
            </Button>
          )}
          {r.target_type === 'subnet' && (
            <Button type="link" size="small" onClick={() => openEdit(r)}>
              {t('ipam.subnet.editBtn')}
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const anyFilter = !!(filterCIDR || filterGroupId || filterTypeId || filterVrfId);
  const visibleData = anyFilter
    ? filterTree(treeData, filterCIDR, filterGroupId, filterTypeId, filterVrfId)
    : treeData;

  return (
    <div>
      {/* Per-field search */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="CIDR (e.g. 10.0.0.0/8)"
          value={filterCIDR}
          onChange={(e) => setFilterCIDR(e.target.value)}
          allowClear style={{ width: 210 }}
        />
        <Select
          placeholder={t('ipam.root.group')}
          value={filterGroupId}
          onChange={setFilterGroupId}
          allowClear style={{ width: 140 }}
          options={groupOpts}
        />
        <Select
          placeholder={t('ipam.root.type')}
          value={filterTypeId}
          onChange={setFilterTypeId}
          allowClear style={{ width: 130 }}
          options={typeOpts}
        />
        <Select
          placeholder="VRF"
          value={filterVrfId}
          onChange={setFilterVrfId}
          allowClear style={{ width: 150 }}
          options={vrfOpts}
        />
      </Space>

      <Table
        columns={columns}
        dataSource={visibleData}
        rowKey="key"
        loading={loading}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpand:        handleExpand,
          indentSize:      20,
          expandRowByClick: false,
        }}
        pagination={{
          defaultPageSize: 10,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
        }}
        locale={{ emptyText: roots.length === 0
          ? 'No root prefixes found — create one in the Root Prefixes tab'
          : t('common.noData') }}
        scroll={{ x: 1040 }}
      />

      {/* Split Modal */}
      <Modal
        title={splitNode?.children?.length ? t('ipam.subnet.reSplitTitle') : t('ipam.subnet.splitTitle')}
        open={splitOpen} onOk={handleSplitSubmit} onCancel={() => setSplitOpen(false)}
        okText={t('ipam.subnet.split')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={splitForm} layout="vertical">
          <p>Target: <strong>{splitNode?.cidr}</strong>&nbsp;
            <Tag color={splitNode?.level === 'Root' ? 'purple' : splitNode?.level === 'L1' ? 'blue' : 'cyan'}>
              {splitNode?.level}
            </Tag>
          </p>
          {splitNode?.children?.length ? (
            <Alert type="error" showIcon message={t('ipam.subnet.reSplitWarn')} style={{ marginBottom: 16 }} />
          ) : null}
          <Form.Item name="target_bits" label={t('ipam.subnet.targetMask')}
            rules={[{ required: true, message: 'Please select a prefix length' }]}>
            <Select placeholder="Select subnet size" options={maskOptions} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Merge Modal */}
      <Modal
        title={t('ipam.subnet.mergeTitle', { cidr: mergeParent?.cidr ?? '' })}
        open={mergeOpen} onOk={handleMergeSubmit} onCancel={() => setMergeOpen(false)}
        okText={t('ipam.subnet.merge')} cancelText={t('common.cancel')} width={620} destroyOnClose
      >
        <Alert type="info" showIcon message={t('ipam.subnet.mergeRules')} style={{ marginBottom: 16 }} />
        <Table
          rowSelection={{ selectedRowKeys: mergeSelected, onChange: setMergeSelected }}
          columns={[
            { title: 'CIDR', dataIndex: 'cidr', key: 'cidr', render: (v: string) => <strong>{v}</strong> },
            { title: 'Level', dataIndex: 'level', key: 'level', width: 80 },
          ]}
          dataSource={mergeParent?.children ?? []}
          rowKey="key" pagination={false} size="small"
        />
      </Modal>

      {/* Edit Subnet Modal */}
      <Modal
        title={t('ipam.subnet.editTitle')}
        open={editOpen} onOk={handleEditSubmit} onCancel={() => setEditOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose width={440}
      >
        <p style={{ marginBottom: 12 }}>
          <strong>{editNode?.cidr}</strong>&nbsp;
          <Tag color={editNode?.level === 'L1' ? 'blue' : 'cyan'}>{editNode?.level}</Tag>
        </p>
        <Form form={editForm} layout="vertical">
          <Form.Item label={t('ipam.root.group')} name="group_id">
            <Select allowClear placeholder="—" options={groupOpts} />
          </Form.Item>
          <Form.Item label={t('ipam.root.type')} name="type_id">
            <Select allowClear placeholder="—" options={typeOpts} />
          </Form.Item>
          <Form.Item label={t('ipam.root.vrf')} name="vrf_id">
            <Select allowClear placeholder="—" options={vrfOpts} />
          </Form.Item>
          <Form.Item label={t('ipam.root.remark')} name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

function findRootId(nodes: UINode[], targetKey: string): number | undefined {
  for (const n of nodes) {
    if (n.target_type === 'root') {
      if (n.key === targetKey || containsKey(n.children ?? [], targetKey)) return n.id;
    }
  }
  return undefined;
}

function containsKey(nodes: UINode[], key: string): boolean {
  return nodes.some((n) => n.key === key || containsKey(n.children ?? [], key));
}

export default TabSubnetTree;

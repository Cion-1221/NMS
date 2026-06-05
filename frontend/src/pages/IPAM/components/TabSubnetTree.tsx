import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Form, Modal, Input, message, Select, Space, Table, Tag,
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapSubnets(subnets: SubnetNode[], is_v4: boolean): UINode[] {
  return subnets.map((s): UINode => ({
    key:         `subnet-${s.id}`,
    id:          s.id,
    cidr:        s.cidr,
    level:       s.level,
    target_type: 'subnet',
    is_v4,
    group_id:    s.group_id,
    group:       s.group ?? null,
    type_id:     s.type_id,
    type:        s.type ?? null,
    vrf_id:      s.vrf_id,
    vrf:         s.vrf ?? null,
    children:    s.children?.length ? mapSubnets(s.children, is_v4) : undefined,
  }));
}


function filterTree(nodes: UINode[], q: string): UINode[] {
  if (!q) return nodes;
  return nodes.reduce<UINode[]>((acc, n) => {
    const filteredChildren = filterTree(n.children ?? [], q);
    if (n.cidr.includes(q) || filteredChildren.length > 0) {
      acc.push({ ...n, children: filteredChildren.length ? filteredChildren : n.children });
    }
    return acc;
  }, []);
}

// ─── Component ────────────────────────────────────────────────────────────────

const TabSubnetTree: React.FC = () => {
  const t = useT();

  const [roots, setRoots]       = useState<RootPrefix[]>([]);
  const [treeData, setTreeData] = useState<UINode[]>([]);
  const [loading, setLoading]   = useState(false);

  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [searchCIDR, setSearchCIDR]     = useState('');

  // Lookup data for dropdowns
  const [groups, setGroups] = useState<IPAMGroup[]>([]);
  const [types,  setTypes]  = useState<IPAMType[]>([]);
  const [vrfs,   setVRFs]   = useState<IPAMVRF[]>([]);

  // Split modal
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitNode, setSplitNode] = useState<UINode | null>(null);
  const [splitForm]               = Form.useForm();

  // Merge modal
  const [mergeOpen, setMergeOpen]         = useState(false);
  const [mergeParent, setMergeParent]     = useState<UINode | null>(null);
  const [mergeSelected, setMergeSelected] = useState<React.Key[]>([]);

  // Edit subnet attributes modal
  const [editOpen, setEditOpen]   = useState(false);
  const [editNode, setEditNode]   = useState<UINode | null>(null);
  const [editForm]                = Form.useForm();

  // ── Initial load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await getRootPrefixes();
        setRoots(res.data);
        const initial: UINode[] = res.data.map((r) => ({
          key:         `root-${r.id}`,
          id:          r.id,
          cidr:        r.cidr,
          level:       'Root',
          target_type: 'root' as const,
          is_v4:       r.ip_version === 4,
          group_id:    r.group_id,
          group:       r.group ?? null,
          type_id:     r.type_id,
          type:        r.type ?? null,
          vrf_id:      r.vrf_id,
          vrf:         r.vrf ?? null,
          children:    [],
        }));
        setTreeData(initial);
      } catch {
        message.error('Failed to load root prefixes');
      } finally {
        setLoading(false);
      }
    })();
    // Load lookups for edit modal
    Promise.all([getGroups(), getIPAMTypes(), getVRFs()]).then(([g, tp, v]) => {
      setGroups(g.data); setTypes(tp.data); setVRFs(v.data);
    }).catch(() => {});
  }, []);

  // ── Refresh ONE root's subtree ────────────────────────────────────────────────
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
    // Only expand the specific root and the operated node — don't expand everything
    setExpandedKeys((prev) => {
      const toAdd = new Set<string>([`root-${rootId}`]);
      if (expandKey) toAdd.add(expandKey);
      return Array.from(new Set([...prev, ...toAdd]));
    });
  }, [roots]);

  // ── Lazy-load children on first expand ───────────────────────────────────────
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
        try {
          await reloadRootSubtree(record.id);
        } catch {
          message.error('Failed to load subnets');
          setTreeData((prev) =>
            prev.map((n) => n.key === record.key ? { ...n, _loading: false } : n),
          );
        }
      }
    }
  };

  // ── Mask options for split modal ──────────────────────────────────────────────
  const maskOptions = (() => {
    if (!splitNode) return [];
    const parts = splitNode.cidr.split('/');
    if (parts.length !== 2) return [];
    const cur = parseInt(parts[1], 10);
    const max = splitNode.is_v4 ? 32 : 128;
    const opts = [];
    for (let i = cur + 1; i <= max && i - cur <= 16; i++) {
      opts.push({
        value: i,
        label: `/${i}  (${t('ipam.subnet.generates', { n: 1 << (i - cur) })})`,
      });
    }
    return opts;
  })();

  // ── Split ─────────────────────────────────────────────────────────────────────
  const openSplit = (node: UINode) => {
    setSplitNode(node); splitForm.resetFields(); setSplitOpen(true);
  };

  const handleSplitSubmit = async () => {
    if (!splitNode) return;
    let v: { target_bits: number };
    try { v = await splitForm.validateFields(); } catch { return; }
    try {
      await splitSubnet({ target_type: splitNode.target_type, target_id: splitNode.id, target_bits: v.target_bits });
      message.success(t('ipam.subnet.splitOk'));
      setSplitOpen(false);
      const affectedRoot = findRootId(treeData, splitNode.key);
      if (affectedRoot) await reloadRootSubtree(affectedRoot, splitNode.key);
    } catch (err: any) {
      if (err instanceof AxiosError && err.response?.data?.error)
        Modal.error({ title: 'Split rejected', content: err.response.data.error });
      else message.error('Split failed');
    }
  };

  // ── Merge ─────────────────────────────────────────────────────────────────────
  const openMerge = (node: UINode) => {
    setMergeParent(node); setMergeSelected([]); setMergeOpen(true);
  };

  const handleMergeSubmit = async () => {
    if (mergeSelected.length < 2) { message.warning('Select at least 2 subnets'); return; }
    try {
      const ids = (mergeSelected as string[]).map((k) => parseInt(k.split('-').pop()!, 10));
      await mergeSubnets({ subnet_ids: ids });
      message.success(t('ipam.subnet.mergeOk'));
      setMergeOpen(false);
      const affectedRoot = mergeParent ? findRootId(treeData, mergeParent.key) : undefined;
      if (affectedRoot) await reloadRootSubtree(affectedRoot, mergeParent?.key);
    } catch (err: any) {
      if (err instanceof AxiosError && err.response?.data?.error)
        Modal.error({ title: 'Merge rejected', content: err.response.data.error });
      else message.error('Merge failed');
    }
  };

  // ── Edit subnet attributes ────────────────────────────────────────────────────
  const openEdit = (node: UINode) => {
    setEditNode(node);
    editForm.setFieldsValue({
      group_id: node.group_id ?? undefined,
      type_id:  node.type_id  ?? undefined,
      vrf_id:   node.vrf_id   ?? undefined,
    });
    setEditOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editNode) return;
    const values = await editForm.validateFields();
    try {
      await updateSubnet(editNode.id, {
        group_id: values.group_id ?? null,
        type_id:  values.type_id  ?? null,
        vrf_id:   values.vrf_id   ?? null,
      });
      message.success(t('ipam.subnet.saveOk'));
      setEditOpen(false);
      const affectedRoot = findRootId(treeData, editNode.key);
      if (affectedRoot) await reloadRootSubtree(affectedRoot);
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
      title:     t('ipam.root.cidr'),
      dataIndex: 'cidr',
      key:       'cidr',
      render:    (v: string, r: UINode) =>
        r.level === 'Root'
          ? <strong style={{ fontSize: 15 }}>{v}</strong>
          : v,
    },
    {
      title:     t('ipam.subnet.level'),
      dataIndex: 'level',
      key:       'level',
      width:     80,
      render:    (l: string) => (
        <Tag color={l === 'Root' ? 'purple' : l === 'L1' ? 'blue' : 'cyan'}>{l}</Tag>
      ),
    },
    {
      title:  t('ipam.root.group'),
      key:    'group',
      width:  120,
      render: (_, r) => r.group?.name || '—',
    },
    {
      title:  t('ipam.root.type'),
      key:    'type',
      width:  120,
      render: (_, r) => r.type?.name || '—',
    },
    {
      title:  t('ipam.root.vrf'),
      key:    'vrf',
      width:  120,
      render: (_, r) => r.vrf ? `${r.vrf.name}${r.vrf.rd ? ` (${r.vrf.rd})` : ''}` : '—',
    },
    {
      title:  t('common.actions'),
      key:    'action',
      width:  240,
      render: (_: unknown, r: UINode) => (
        <Space>
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

  const visibleData = searchCIDR ? filterTree(treeData, searchCIDR.trim()) : treeData;

  return (
    <div>
      {/* Search */}
      <Space style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('ipam.subnet.search')}
          value={searchCIDR}
          onChange={(e) => setSearchCIDR(e.target.value)}
          allowClear
          style={{ width: 240 }}
        />
      </Space>

      {/* Tree table */}
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
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (n) => `${n} root prefixes` }}
        locale={{ emptyText: roots.length === 0
          ? 'No root prefixes found — create one in the Root Prefixes tab'
          : t('common.noData') }}
        scroll={{ x: 900 }}
      />

      {/* Split Modal */}
      <Modal
        title={splitNode?.children?.length ? t('ipam.subnet.reSplitTitle') : t('ipam.subnet.splitTitle')}
        open={splitOpen}
        onOk={handleSplitSubmit}
        onCancel={() => setSplitOpen(false)}
        okText={t('ipam.subnet.split')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Form form={splitForm} layout="vertical">
          <p>
            Target: <strong>{splitNode?.cidr}</strong>&nbsp;
            <Tag color={splitNode?.level === 'Root' ? 'purple' : splitNode?.level === 'L1' ? 'blue' : 'cyan'}>
              {splitNode?.level}
            </Tag>
          </p>
          {splitNode?.children?.length ? (
            <Alert type="error" showIcon message={t('ipam.subnet.reSplitWarn')} style={{ marginBottom: 16 }} />
          ) : null}
          <Form.Item
            name="target_bits"
            label={t('ipam.subnet.targetMask')}
            rules={[{ required: true, message: 'Please select a prefix length' }]}
          >
            <Select placeholder="Select subnet size" options={maskOptions} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Merge Modal */}
      <Modal
        title={t('ipam.subnet.mergeTitle', { cidr: mergeParent?.cidr ?? '' })}
        open={mergeOpen}
        onOk={handleMergeSubmit}
        onCancel={() => setMergeOpen(false)}
        okText={t('ipam.subnet.merge')}
        cancelText={t('common.cancel')}
        width={620}
        destroyOnClose
      >
        <Alert type="info" showIcon message={t('ipam.subnet.mergeRules')} style={{ marginBottom: 16 }} />
        <Table
          rowSelection={{ selectedRowKeys: mergeSelected, onChange: setMergeSelected }}
          columns={[
            { title: 'CIDR',  dataIndex: 'cidr',  key: 'cidr',  render: (v: string) => <strong>{v}</strong> },
            { title: 'Level', dataIndex: 'level', key: 'level', width: 80 },
          ]}
          dataSource={mergeParent?.children ?? []}
          rowKey="key"
          pagination={false}
          size="small"
        />
      </Modal>

      {/* Edit Subnet Attributes Modal */}
      <Modal
        title={t('ipam.subnet.editTitle')}
        open={editOpen}
        onOk={handleEditSubmit}
        onCancel={() => setEditOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
        width={420}
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
        </Form>
      </Modal>
    </div>
  );
};

/** Walk the tree to find which Root-level node contains the given key */
function findRootId(nodes: UINode[], targetKey: string): number | undefined {
  for (const n of nodes) {
    if (n.target_type === 'root') {
      if (n.key === targetKey || containsKey(n.children ?? [], targetKey)) {
        return n.id;
      }
    }
  }
  return undefined;
}

function containsKey(nodes: UINode[], key: string): boolean {
  return nodes.some((n) => n.key === key || containsKey(n.children ?? [], key));
}

export default TabSubnetTree;

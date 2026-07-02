import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Space, Table, message } from 'antd';
import { ReloadOutlined, SearchOutlined, UnlockOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listLockouts, unlockLockouts } from '../../../../api/system';
import type { LockoutEntry } from '../../../../types/system';
import { apiErrMsg, useT } from '../../../../i18n';
import { useDebounced } from '../../../../utils/useDebounced';
import StatusTag from '../../../../components/StatusTag';
import { FONT_MONO } from '../../../../theme/theme';

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

// ─────────────────────────────────────────────────────────────────────────────
// 锁定列表 Tab：服务端分页查看当前被锁定的「用户名 + IP」，
// 支持搜索（用户名/IP 模糊匹配）、单条/批量手动解除。
// ─────────────────────────────────────────────────────────────────────────────

const TabLockouts: React.FC = () => {
  const t = useT();

  const [lockouts,     setLockouts]     = useState<LockoutEntry[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [search,       setSearch]       = useState('');
  const [page,         setPage]         = useState(1);
  const [pageSize,     setPageSize]     = useState(10);
  const [total,        setTotal]        = useState(0);

  // 搜索输入防抖后再发请求；序号守卫丢弃乱序返回的过期响应
  const debSearch = useDebounced(search);
  const reqSeq = useRef(0);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await listLockouts({
        page,
        page_size: pageSize,
        q:         debSearch || undefined,
      });
      if (seq !== reqSeq.current) return;
      // 批量解除后当前页可能为空 —— 自动回退一页重新加载
      if (r.data.items.length === 0 && r.data.total > 0 && page > 1) {
        setPage(p => Math.max(1, p - 1));
        return;
      }
      setLockouts(r.data.items);
      setTotal(r.data.total);
      setSelectedKeys([]); // 刷新后清空选择，避免选中已消失的条目
    } catch (err: any) {
      if (seq === reqSeq.current) {
        message.error(apiErrMsg(err));
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debSearch]);

  // 搜索条件变化时回到第一页
  useEffect(() => { setPage(1); }, [debSearch]);

  // 分页 / 搜索任一变化即重新查询；首次挂载同样由此触发
  useEffect(() => { void loadData(); }, [loadData]);

  const handleUnlock = async (keys: string[]) => {
    try {
      const r = await unlockLockouts(keys);
      message.success(t('sysset.lockouts.unlockOk').replace('{n}', String(r.data.unlocked)));
      void loadData();
    } catch (err: any) {
      message.error(apiErrMsg(err));
    }
  };

  const remainingMinutes = (until: string) =>
    Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));

  const columns: ColumnsType<LockoutEntry> = [
    { title: t('sys.user.username'), dataIndex: 'username', key: 'username', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: t('sysset.lockouts.ip'), dataIndex: 'ip', key: 'ip', width: 160, render: (v: string) => mono(v) },
    {
      title: t('sysset.lockouts.lockedAt'), dataIndex: 'locked_at', key: 'locked_at', width: 180,
      render: (v: string) => mono(new Date(v).toLocaleString()),
    },
    {
      title: t('sysset.lockouts.lockedUntil'), dataIndex: 'locked_until', key: 'locked_until', width: 180,
      render: (v: string) => mono(new Date(v).toLocaleString()),
    },
    {
      title: t('sysset.lockouts.remaining'), key: 'remaining', width: 110, align: 'center' as const,
      render: (_: unknown, r: LockoutEntry) => (
        <StatusTag status="warn" label={`${remainingMinutes(r.locked_until)} ${t('sysset.lockouts.minutes')}`} />
      ),
    },
    {
      title: t('common.actions'), key: 'action', width: 100,
      render: (_: unknown, r: LockoutEntry) => (
        <Button type="link" size="small" icon={<UnlockOutlined />}
          onClick={() => { void handleUnlock([r.key]); }}>
          {t('sysset.lockouts.unlock')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      {/* ── 搜索 + 操作栏 ── */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('sysset.lockouts.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 240 }}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => { void loadData(); }}
          loading={loading}
        >
          {t('common.refresh')}
        </Button>
        <Button
          type="primary"
          danger
          icon={<UnlockOutlined />}
          disabled={selectedKeys.length === 0}
          onClick={() => { void handleUnlock(selectedKeys as string[]); }}
        >
          {t('sysset.lockouts.unlockSelected')}
          {selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ''}
        </Button>
      </Space>

      {/* ── 锁定列表（服务端分页）── */}
      <Table
        columns={columns}
        dataSource={lockouts}
        rowKey="key"
        loading={loading}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: setSelectedKeys,
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
          onChange: (p, ps) => {
            // 切换每页条数时回到第一页，避免落在超出范围的页码上
            if (ps !== pageSize) {
              setPageSize(ps);
              setPage(1);
            } else {
              setPage(p);
            }
          },
        }}
        scroll={{ x: 'max-content' }}
      />
    </div>
  );
};

export default TabLockouts;

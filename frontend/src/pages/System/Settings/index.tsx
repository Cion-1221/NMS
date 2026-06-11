import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Form, Input, InputNumber, Space, Spin, Switch, Table,
  Tag, Typography, message,
} from 'antd';
import {
  ReloadOutlined, SafetyCertificateOutlined, SearchOutlined, UnlockOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getSecuritySettings, updateSecuritySettings, listLockouts, unlockLockouts,
} from '../../../api/system';
import type { SecuritySettings, LockoutEntry } from '../../../types/system';
import { useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';

const { Title } = Typography;

// ─────────────────────────────────────────────────────────────────────────────
// 系统安全设置：
//   1. 登录防爆破阈值（滑动窗口失败计数 + 临时锁定）
//   2. 锁定列表 —— 查看当前被锁定的「用户名 + IP」，支持搜索、单条/批量解除
// 仅管理员可见（路由级 + 后端 AdminRequired 双重保障）。
// ─────────────────────────────────────────────────────────────────────────────

const SystemSettingsPage: React.FC = () => {
  const t = useT();

  // ── 防爆破阈值表单 ─────────────────────────────────────────────────────────
  const [form] = Form.useForm<SecuritySettings>();
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  // 关闭总开关时禁用阈值输入，避免误导（值仍保留，再次开启即恢复）
  const enabled = Form.useWatch('enabled', form);

  const load = async () => {
    setLoading(true);
    try {
      const r = await getSecuritySettings();
      form.setFieldsValue(r.data);
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await updateSecuritySettings(values);
      message.success(t('sysset.saveOk'));
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // ── 锁定列表（服务端分页 + 搜索）───────────────────────────────────────────
  const [lockouts,     setLockouts]     = useState<LockoutEntry[]>([]);
  const [lockLoading,  setLockLoading]  = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [lockSearch,   setLockSearch]   = useState('');
  const [lockPage,     setLockPage]     = useState(1);
  const [lockPageSize, setLockPageSize] = useState(10);
  const [lockTotal,    setLockTotal]    = useState(0);

  // 搜索输入防抖后再发请求；序号守卫丢弃乱序返回的过期响应
  const debLockSearch = useDebounced(lockSearch);
  const lockReqSeq = useRef(0);

  const loadLockouts = useCallback(async () => {
    const seq = ++lockReqSeq.current;
    setLockLoading(true);
    try {
      const r = await listLockouts({
        page:      lockPage,
        page_size: lockPageSize,
        q:         debLockSearch || undefined,
      });
      if (seq !== lockReqSeq.current) return;
      // 批量解除后当前页可能为空 —— 自动回退一页重新加载
      if (r.data.items.length === 0 && r.data.total > 0 && lockPage > 1) {
        setLockPage(p => Math.max(1, p - 1));
        return;
      }
      setLockouts(r.data.items);
      setLockTotal(r.data.total);
      setSelectedKeys([]); // 刷新后清空选择，避免选中已消失的条目
    } catch (err: any) {
      if (seq === lockReqSeq.current) {
        message.error(err?.response?.data?.error ?? 'Failed to load lockouts');
      }
    } finally {
      if (seq === lockReqSeq.current) setLockLoading(false);
    }
  }, [lockPage, lockPageSize, debLockSearch]);

  // 搜索条件变化时回到第一页
  useEffect(() => { setLockPage(1); }, [debLockSearch]);

  // 分页 / 搜索任一变化即重新查询；首次挂载同样由此触发
  useEffect(() => { void loadLockouts(); }, [loadLockouts]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUnlock = async (keys: string[]) => {
    try {
      const r = await unlockLockouts(keys);
      message.success(t('sysset.lockouts.unlockOk').replace('{n}', String(r.data.unlocked)));
      void loadLockouts();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Unlock failed');
    }
  };

  const remainingMinutes = (until: string) =>
    Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));

  const lockoutColumns: ColumnsType<LockoutEntry> = [
    { title: t('sys.user.username'), dataIndex: 'username', key: 'username' },
    { title: t('sysset.lockouts.ip'), dataIndex: 'ip', key: 'ip', width: 160 },
    {
      title: t('sysset.lockouts.lockedAt'), dataIndex: 'locked_at', key: 'locked_at', width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t('sysset.lockouts.lockedUntil'), dataIndex: 'locked_until', key: 'locked_until', width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t('sysset.lockouts.remaining'), key: 'remaining', width: 110, align: 'center' as const,
      render: (_: unknown, r: LockoutEntry) => (
        <Tag color="orange">{remainingMinutes(r.locked_until)} {t('sysset.lockouts.minutes')}</Tag>
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

  // ───────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 960 }}>
      <Title level={4} style={{ marginTop: 0 }}>
        <SafetyCertificateOutlined style={{ marginRight: 8 }} />
        {t('sysset.title')}
      </Title>

      {/* ── 防爆破阈值 ── */}
      <Card style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          message={t('sysset.desc')}
          style={{ marginBottom: 24 }}
        />

        <Spin spinning={loading}>
          <Form form={form} layout="vertical" style={{ maxWidth: 560 }}>
            <Form.Item
              label={t('sysset.enabled')}
              name="enabled"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>

            <Form.Item
              label={t('sysset.maxAttempts')}
              name="max_attempts"
              rules={[{ required: true, type: 'number', min: 1, max: 100 }]}
              extra={t('sysset.maxAttemptsHint')}
            >
              <InputNumber min={1} max={100} style={{ width: 200 }} disabled={!enabled} />
            </Form.Item>

            <Form.Item
              label={t('sysset.windowMinutes')}
              name="window_minutes"
              rules={[{ required: true, type: 'number', min: 1, max: 1440 }]}
              extra={t('sysset.windowMinutesHint')}
            >
              <InputNumber min={1} max={1440} style={{ width: 200 }} disabled={!enabled} />
            </Form.Item>

            <Form.Item
              label={t('sysset.lockoutMinutes')}
              name="lockout_minutes"
              rules={[{ required: true, type: 'number', min: 1, max: 1440 }]}
              extra={t('sysset.lockoutMinutesHint')}
            >
              <InputNumber min={1} max={1440} style={{ width: 200 }} disabled={!enabled} />
            </Form.Item>

            <Space>
              <Button type="primary" loading={saving} onClick={handleSave}>
                {t('common.save')}
              </Button>
              <Button onClick={() => { void load(); }} disabled={loading}>
                {t('common.refresh')}
              </Button>
            </Space>
          </Form>
        </Spin>
      </Card>

      {/* ── 锁定列表 ── */}
      <Card title={t('sysset.lockouts.title')}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder={t('sysset.lockouts.search')}
            value={lockSearch}
            onChange={e => setLockSearch(e.target.value)}
            allowClear
            style={{ width: 240 }}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => { void loadLockouts(); }}
            loading={lockLoading}
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

        <Table
          columns={lockoutColumns}
          dataSource={lockouts}
          rowKey="key"
          size="small"
          loading={lockLoading}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys,
          }}
          pagination={{
            current: lockPage,
            pageSize: lockPageSize,
            total: lockTotal,
            pageSizeOptions: ['10', '20', '50', '100'],
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
            onChange: (p, ps) => {
              // 切换每页条数时回到第一页，避免落在超出范围的页码上
              if (ps !== lockPageSize) {
                setLockPageSize(ps);
                setLockPage(1);
              } else {
                setLockPage(p);
              }
            },
          }}
        />
      </Card>
    </div>
  );
};

export default SystemSettingsPage;

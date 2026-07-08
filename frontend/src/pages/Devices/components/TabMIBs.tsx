/**
 * TabMIBs — MIB 文件库管理（Devices → MIBs）。
 *
 * 定位：第一阶段是资产留存 + 校验入库（服务端提取 SMI 模块名、SHA256、去重），
 * 供后续自定义 OID 采集的翻译引擎按模块加载。查看/下载登录即可，上传/删除仅
 * 管理员（与 Agent Releases 同基调——内容会落盘到服务器文件系统）。
 */
import React, { useEffect, useState } from 'react';
import { Alert, Button, Modal, Space, Table, Tooltip, Upload, message } from 'antd';
import {
  DeleteOutlined, DownloadOutlined, ExclamationCircleFilled, ReloadOutlined, UploadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getDeviceMIBs, uploadDeviceMIB, deleteDeviceMIB, downloadDeviceMIB } from '../../../api/device';
import type { DeviceMIB } from '../../../types/device';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_ADMIN, useCan } from '../../../utils/perms';
import RelativeTime from '../../../components/RelativeTime';
import StatusTag from '../../../components/StatusTag';
import { FONT_MONO } from '../../../theme/theme';

const { confirm } = Modal;

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

/** 字节数 → 可读大小（MIB 文件都在 KB～MB 量级） */
function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

const TabMIBs: React.FC = () => {
  const t = useT();
  const isAdmin = useCan(PERM_ADMIN);

  const [data, setData] = useState<DeviceMIB[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const r = await getDeviceMIBs();
      setData(r.data);
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  // Upload 组件 beforeUpload 返回 false 阻断默认行为，改为手动 multipart 提交
  const handleUpload = (file: File): boolean => {
    setUploading(true);
    uploadDeviceMIB(file)
      .then(r => {
        message.success(t('device.mib.uploadOk', { module: r.data.module_name }));
        void loadData();
      })
      .catch((err: unknown) => { message.error(apiErrMsg(err)); })
      .finally(() => setUploading(false));
    return false;
  };

  const handleDelete = (r: DeviceMIB) => {
    confirm({
      title:      t('device.mib.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('device.mib.delBody', { module: r.module_name }),
      okText:     t('common.delete'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteDeviceMIB(r.id);
          message.success(t('device.mib.delDone'));
          void loadData();
        } catch (err: unknown) {
          message.error(apiErrMsg(err));
        }
      },
    });
  };

  const handleDownload = async (r: DeviceMIB) => {
    try {
      await downloadDeviceMIB(r.id, r.file_name);
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    }
  };

  const columns: ColumnsType<DeviceMIB> = [
    { title: t('common.id'), dataIndex: 'id', key: 'id', width: 60, render: (v: number) => mono(v) },
    {
      title: t('device.mib.module'), dataIndex: 'module_name', key: 'module_name', width: 260,
      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    { title: t('device.mib.fileName'), dataIndex: 'file_name', key: 'file_name', width: 220, ellipsis: true },
    {
      title: t('device.mib.size'), dataIndex: 'file_size', key: 'file_size', width: 100,
      render: (v: number) => mono(formatSize(v)),
    },
    {
      // 翻译引擎解析状态：失败常见原因是 IMPORTS 依赖模块未上传，补传后自动转好
      title: t('device.mib.parsed'), key: 'parsed', width: 110,
      render: (_: unknown, r: DeviceMIB) => r.parsed
        ? <StatusTag status="ok" label={t('device.mib.parsedOk')} tone="success" />
        : (
          <Tooltip title={r.parse_error || undefined}>
            <span><StatusTag status="failed" label={t('device.mib.parsedFail')} tone="warning" /></span>
          </Tooltip>
        ),
    },
    {
      title: 'SHA256', dataIndex: 'sha256', key: 'sha256', width: 140,
      render: (v: string) => v
        ? <Tooltip title={v}>{mono(v.slice(0, 12) + '…')}</Tooltip>
        : '—',
    },
    { title: t('device.mib.uploadedBy'), dataIndex: 'uploaded_by', key: 'uploaded_by', width: 120 },
    {
      title: t('device.mib.uploadedAt'), dataIndex: 'created_at', key: 'created_at', width: 140,
      render: (v: string) => <RelativeTime value={v} />,
    },
    {
      title: t('common.actions'), key: 'action', width: 160,
      render: (_: unknown, r: DeviceMIB) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => { void handleDownload(r); }}>
            {t('device.mib.download')}
          </Button>
          {isAdmin && (
            <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(r)}>
              {t('common.delete')}
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        message={t('device.mib.hint')}
        style={{ marginBottom: 16 }}
      />
      <Space style={{ marginBottom: 16 }}>
        {isAdmin && (
          <Upload
            accept=".mib,.txt,.my,.smi"
            showUploadList={false}
            beforeUpload={handleUpload}
          >
            <Button type="primary" icon={<UploadOutlined />} loading={uploading}>
              {t('device.mib.upload')}
            </Button>
          </Upload>
        )}
        <Button icon={<ReloadOutlined />} onClick={() => { void loadData(); }} loading={loading}>
          {t('common.refresh')}
        </Button>
      </Space>
      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20, showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}` }}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default TabMIBs;

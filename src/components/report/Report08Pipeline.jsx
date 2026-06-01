import React from 'react';
import { Footer, ReportSlide, TopBar } from './primitives.jsx';
import { ChartSwitch } from '../charts/index.jsx';

const rows = [
  ['Q1', '品牌重启', '$4.2M', '$6.8M', '+62%'],
  ['Q2', '需求引擎', '$8.1M', '$13.4M', '+65%'],
  ['Q3', '内容与社区', '$9.8M', '$11.2M', '+14%'],
  ['Q4', '留存与扩张', '$8.9M', '$11.4M', '+28%'],
  ['2025', '合计', '$31.0M', '$42.8M', '+38%'],
];

export function Report08Pipeline() {
  const chartRows = rows.slice(0, -1).map(([quarter, project, , pipeline, delta], index) => ({
    label: `${quarter} · ${project}`,
    value: Number.parseFloat(pipeline.replace(/[$M]/g, '')) || 0,
    display: `${pipeline} / ${delta}`,
    tone: index === 1 ? 'focus' : '',
  }));

  return (
    <ReportSlide layout="RP08" className="rp-cream">
      <div className="rp-page rp-pad">
        <TopBar eyebrow="章节 · 02 · 结果" />
        <div className="rp-two-head">
          <h1 className="rp-title">管道贡献。</h1>
          <p className="rp-body">按季度拆分的营销来源管道额，对比 2024 年基线。</p>
        </div>
        <div className="rp-chart-wrap rp-pipeline-chart">
          <ChartSwitch title="季度管道额" rows={chartRows} className="rp-chart-switch" />
        </div>
        <Footer left="03 · 管道额" right="市场营销 · 2025 年终" />
      </div>
    </ReportSlide>
  );
}

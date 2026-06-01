import React from 'react';
import { BlackTechSlide, BottomRule, ChartSwitch } from './primitives.jsx';

const defaultRows = [
  ['业务一部', '96%', '+18%'],
  ['业务二部', '84%', '+11%'],
  ['业务三部', '78%', '+7%'],
  ['创新项目', '63%', '+22%'],
  ['核心客户', '97%', '+26%', true],
];

export function BT08Compression({
  chrome = { left: '07 · RESULT', right: 'PAGE 08/12', bottomLeft: 'BENCHMARK TABLE', bottomRight: '◦ SUMMARY' },
  eyebrow = '07',
  accent = '结果总结',
  percent = '97',
  percentSuffix = '%',
  subtitle = '核心客户年度目标达成率，\n是全年增长质量最稳定的支撑。',
  tableTitle = 'TABLE · BUSINESS COMPARISON',
  columns = ['板块', '达成率', '同比'],
  rows = defaultRows,
  footerLeft = 'SAMPLE / DATA SOURCE: FINANCE + CRM',
  footerRight = 'conclusion > detail',
}) {
  const chartRows = rows.map(([label, percentValue, delta, focus]) => ({
    label,
    value: Number.parseFloat(percentValue) || 0,
    display: `${percentValue} · ${delta}`,
    tone: focus ? 'focus' : '',
  }));

  return (
    <BlackTechSlide
      layout="BT08"
      chrome={chrome}
    >
      <div className="bt-pad">
        <div className="bt-eyebrow">{eyebrow} · <span className="bt-accent">{accent}</span></div>
        <div className="bt-compression-grid">
          <div>
            <div className="bt-percent">{percent}<span>{percentSuffix}</span></div>
            <div className="bt-subtitle">{subtitle}</div>
          </div>
          <div>
            <div className="bt-small">{tableTitle}</div>
            <ChartSwitch title={columns.join(' / ')} rows={chartRows} className="bt-compression-chart" />
          </div>
        </div>
        <BottomRule left={footerLeft} right={footerRight} />
      </div>
    </BlackTechSlide>
  );
}

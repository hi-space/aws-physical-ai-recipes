interface RegionFilterProps {
  regions: string[];
  selected: string;
  onChange: (region: string) => void;
}

export default function RegionFilter({ regions, selected, onChange }: RegionFilterProps) {
  const items = ['all', ...regions];
  return (
    <div className="flex gap-2 flex-wrap">
      {items.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            selected === r
              ? 'bg-aws-dark text-white'
              : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'
          }`}
        >
          {r === 'all' ? 'All Regions' : r}
        </button>
      ))}
    </div>
  );
}

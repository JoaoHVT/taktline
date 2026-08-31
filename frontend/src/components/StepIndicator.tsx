import { Check } from 'lucide-react'

export interface Step {
  id:    number
  label: string
  desc:  string
}

interface Props {
  steps:   Step[]
  current: number   // 1-based
}

export function StepIndicator({ steps, current }: Props) {
  return (
    <div className="flex items-center gap-0">
      {steps.map((step, idx) => {
        const done   = current > step.id
        const active = current === step.id
        const last   = idx === steps.length - 1

        return (
          <div key={step.id} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              {/* circle */}
              <div
                className={[
                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all',
                  done
                    ? 'bg-green-700 border-green-700 text-white'
                    : active
                    ? 'bg-red-700 border-red-700 text-white'
                    : 'bg-white border-gray-300 text-gray-400',
                ].join(' ')}
              >
                {done ? <Check size={14} /> : step.id}
              </div>
              {/* labels */}
              <div className="text-center hidden sm:block">
                <p className={`text-xs font-medium leading-tight ${active ? 'text-red-700' : done ? 'text-green-700' : 'text-gray-400'}`}>
                  {step.label}
                </p>
                <p className="text-[10px] text-gray-400 leading-tight">{step.desc}</p>
              </div>
            </div>
            {/* connector */}
            {!last && (
              <div className={`flex-1 h-0.5 mx-2 mb-5 transition-all ${done ? 'bg-green-600' : 'bg-gray-200'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

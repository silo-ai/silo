import {
  measureNaturalWidth as pretextMeasureNaturalWidth,
  prepareWithSegments,
} from '@chenglou/pretext'

type ReportTocMeasurement = {
  measureLabelWidth: (text: string, font: string, letterSpacing: number) => number
}

type ReportViewerGlobal = typeof globalThis & {
  siloReportViewerPretext?: ReportTocMeasurement
  siloReportViewerPretextReady?: () => void
}

const reportViewerGlobal = globalThis as ReportViewerGlobal

reportViewerGlobal.siloReportViewerPretext = {
  measureLabelWidth(text, font, letterSpacing) {
    return pretextMeasureNaturalWidth(prepareWithSegments(text, font, { letterSpacing }))
  },
}
reportViewerGlobal.siloReportViewerPretextReady?.()

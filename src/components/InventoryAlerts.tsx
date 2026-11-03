import { useEffect, useState } from "react";
import { ApiService } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  Bell,
} from "lucide-react";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface InventoryAlert {
  productName: string;
  sku: string;
  currentStock: number;
  reorderLevel: number;
  suggestedReorderQty: number;
  urgency: "critical" | "high" | "medium" | "low";
  reasoning: string;
}

interface SalesForecast {
  next7Days: number | string;
  next30Days: number | string;
  trendDirection: "increasing" | "stable" | "decreasing";
  confidence: "high" | "medium" | "low";
  baselineDailySales: number | string;
  historyDays: number;
  historicalTransactions: number;
  activeSalesDays: number;
}

interface DemandPattern {
  pattern: string;
  insight: string;
}

interface PredictionResponse {
  success: boolean;
  source?: "statistical";
  warning?: string;
  metadata?: {
    dataStart: string;
    dataEnd: string;
    completedTransactions: number;
    productsAnalyzed: number;
    criticalItems: number;
    forecastMethod: string;
  };
  predictions: {
    inventoryAlerts?: InventoryAlert[];
    salesForecast?: SalesForecast | null;
    demandPatterns?: DemandPattern[];
    recommendations?: string[];
  };
  error?: string;
}

export function InventoryAlerts() {
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [forecast, setForecast] = useState<SalesForecast | null>(null);
  const [patterns, setPatterns] = useState<DemandPattern[]>([]);
  const [recommendations, setRecommendations] = useState<string[]>([]);
  const [source, setSource] = useState<"statistical" | null>(null);
  const [metadata, setMetadata] = useState<PredictionResponse["metadata"]>();
  const [warning, setWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadPredictions();
  }, []);

  const loadPredictions = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await ApiService.get<PredictionResponse>(
        "/inventory/predictions",
      );

      if (!data?.success) {
        const message = data?.error || "Failed to generate predictions";
        setLoadError(message);
        toast.error(message);
        return;
      }

      const { predictions } = data;
      setSource(data.source || "statistical");
      setMetadata(data.metadata);
      setWarning(data.warning || null);
      setAlerts(predictions.inventoryAlerts || []);
      setForecast(predictions.salesForecast || null);
      setPatterns(predictions.demandPatterns || []);
      setRecommendations(predictions.recommendations || []);

    } catch (error) {
      console.error("Load predictions error:", error);
      const message =
        error instanceof Error ? error.message : "Failed to load predictions";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case "critical":
        return "destructive";
      case "high":
        return "destructive";
      case "medium":
        return "default";
      case "low":
        return "secondary";
      default:
        return "secondary";
    }
  };

  const getTrendIcon = (direction: string) => {
    switch (direction) {
      case "increasing":
        return <TrendingUp className="h-4 w-4 text-green-500" />;
      case "decreasing":
        return <TrendingDown className="h-4 w-4 text-red-500" />;
      default:
        return <Minus className="h-4 w-4 text-yellow-500" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">Sales Forecast & Stock Guidance</h2>
        </div>
        <div className="flex items-center gap-2">
          {source && (
            <Badge variant="outline">
              Sales-history estimate
            </Badge>
          )}
          <Button
            onClick={loadPredictions}
            disabled={loading}
            size="sm"
            variant="outline"
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh Predictions
          </Button>
        </div>
      </div>

      {warning && (
        <div
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
        >
          {warning}
        </div>
      )}

      {metadata && (
        <p className="text-sm text-muted-foreground">
          Based on {metadata.completedTransactions} completed transactions from{" "}
          {new Date(`${metadata.dataStart}T12:00:00`).toLocaleDateString()} through{" "}
          {new Date(`${metadata.dataEnd}T12:00:00`).toLocaleDateString()}. Forecasts use the
          average daily sales from the most recent 30 complete days; stock
          quantities target each product&apos;s configured reorder level.
        </p>
      )}

      {loadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3"
        >
          <p className="text-sm text-destructive">
            Predictions unavailable: {loadError}
          </p>
          <Button
            onClick={loadPredictions}
            disabled={loading}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Sales Forecast Card */}
      {forecast && (
        <Card className="border-primary/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {getTrendIcon(forecast.trendDirection)}
              Sales Forecast Estimate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Estimated next 7 days</p>
                <p className="text-2xl font-bold">
                  {formatKesCents(
                    parseKesToCents(String(forecast.next7Days)),
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Estimated next 30 days</p>
                <p className="text-2xl font-bold">
                  {formatKesCents(
                    parseKesToCents(String(forecast.next30Days)),
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Trend & history quality
                </p>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {forecast.trendDirection}
                  </Badge>
                  <Badge variant="secondary" className="capitalize">
                    {forecast.confidence}
                  </Badge>
                </div>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Recent daily average:{" "}
              {formatKesCents(
                parseKesToCents(String(forecast.baselineDailySales)),
              )}{" "}
              across {forecast.historyDays} complete days and{" "}
              {forecast.activeSalesDays} days with sales. This is a historical
              estimate, not a guarantee.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Inventory Alerts Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-500" />
            Stock Reorder Recommendations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : loadError ? (
            <p className="py-8 text-center text-muted-foreground">
              Retry predictions to view current inventory recommendations.
            </p>
          ) : alerts.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              All stock levels are healthy. No alerts at this time.
            </p>
          ) : (
            <div className="max-h-[28rem] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Current Stock</TableHead>
                  <TableHead>Reorder Level</TableHead>
                  <TableHead>Suggested Reorder</TableHead>
                  <TableHead>Urgency</TableHead>
                  <TableHead>Reasoning</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((alert) => (
                  <TableRow key={alert.sku} className="animate-fade-in">
                    <TableCell className="font-medium">
                      {alert.productName}
                    </TableCell>
                    <TableCell>{alert.sku}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          alert.currentStock === 0 ? "destructive" : "outline"
                        }
                      >
                        {alert.currentStock}
                      </Badge>
                    </TableCell>
                    <TableCell>{alert.reorderLevel}</TableCell>
                    <TableCell>
                      <span className="font-semibold text-primary">
                        {alert.suggestedReorderQty} units
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={getUrgencyColor(alert.urgency)}
                        className="capitalize"
                      >
                        {alert.urgency}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <p className="text-sm text-muted-foreground">
                        {alert.reasoning}
                      </p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Demand Patterns */}
      {patterns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Demand Patterns & Insights</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              {patterns.map((pattern, idx) => (
                <div
                  key={idx}
                  className="border-l-4 border-primary pl-4 py-2 animate-fade-in"
                >
                  <h4 className="font-semibold">{pattern.pattern}</h4>
                  <p className="text-sm text-muted-foreground mt-1">
                    {pattern.insight}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI Recommendations */}
      {recommendations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Data-based Recommendations</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {recommendations.map((rec, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2 animate-fade-in"
                >
                  <span className="text-primary font-bold">•</span>
                  <span className="text-sm">{rec}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

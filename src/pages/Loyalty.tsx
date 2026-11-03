import { useState, useEffect } from "react";
import { ApiService } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";
import {
  Award,
  Gift,
  TrendingUp,
  Users,
  Star,
  Search,
  RefreshCw,
} from "lucide-react";

interface LoyaltyMember {
  id: string;
  customer_id: string;
  points: number;
  tier: string;
  total_spent: number | string;
  created_at: string;
  customer?: {
    name: string;
    phone: string;
  };
  customers?: {
    name: string;
    phone: string;
  };
}

type LoyaltyMemberResponse = Omit<LoyaltyMember, "points"> & {
  points: number | string;
};

interface LoyaltyTier {
  name: string;
  min: number;
  color: string;
  pointsMultiplier: number;
}

interface RegisteredCustomer {
  id: string;
  name: string;
  phone: string;
}

export default function Loyalty() {
  const [members, setMembers] = useState<LoyaltyMember[]>([]);
  const [customers, setCustomers] = useState<RegisteredCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [tiers, setTiers] = useState<LoyaltyTier[]>([
    { name: "Bronze", min: 0, color: "bg-amber-700", pointsMultiplier: 1 },
    { name: "Silver", min: 50000, color: "bg-gray-400", pointsMultiplier: 1.5 },
    { name: "Gold", min: 150000, color: "bg-yellow-500", pointsMultiplier: 2 },
    {
      name: "Platinum",
      min: 300000,
      color: "bg-purple-500",
      pointsMultiplier: 3,
    },
  ]);
  const [loyaltySettings, setLoyaltySettings] = useState({
    pointsRate: 1,
    pointsPerAmount: 100,
  });

  useEffect(() => {
    loadLoyaltySettings();
    loadLoyaltyMembers();
    loadCustomers();
  }, []);

  const loadLoyaltySettings = async () => {
    try {
      const settingsMap =
        await ApiService.get<Record<string, string>>("/loyalty/settings");

      setTiers([
        { name: "Bronze", min: 0, color: "bg-amber-700", pointsMultiplier: 1 },
        {
          name: "Silver",
          min: parseFloat(settingsMap.loyalty_tier_silver_min) || 50000,
          color: "bg-gray-400",
          pointsMultiplier: 1.5,
        },
        {
          name: "Gold",
          min: parseFloat(settingsMap.loyalty_tier_gold_min) || 150000,
          color: "bg-yellow-500",
          pointsMultiplier: 2,
        },
        {
          name: "Platinum",
          min: parseFloat(settingsMap.loyalty_tier_platinum_min) || 300000,
          color: "bg-purple-500",
          pointsMultiplier: 3,
        },
      ]);

      setLoyaltySettings({
        pointsRate: parseFloat(settingsMap.loyalty_points_rate) || 1,
        pointsPerAmount:
          parseFloat(settingsMap.loyalty_points_per_amount) || 100,
      });
    } catch (error) {
      toast.error(error.message || "Failed to load loyalty settings");
    }
  };

  const loadLoyaltyMembers = async () => {
    try {
      const data = await ApiService.get<LoyaltyMemberResponse[]>("/loyalty/members");
      if (!Array.isArray(data)) {
        throw new Error("The server returned an invalid loyalty customer list");
      }
      setMembers(
        data.map((member) => ({
          ...member,
          points: Number(member.points),
          customer: member.customer ?? member.customers,
        })),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Error loading loyalty customers",
      );
    } finally {
      setLoading(false);
    }
  };

  const loadCustomers = async () => {
    try {
      const data = await ApiService.get<RegisteredCustomer[]>("/customers");
      setCustomers(data || []);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load registered customers",
      );
    }
  };

  const enrollCustomer = async () => {
    if (!selectedCustomerId) {
      toast.error("Select a registered customer to enroll");
      return;
    }

    setEnrolling(true);
    try {
      await ApiService.post("/loyalty/members", {
        customer_id: selectedCustomerId,
        points: 0,
        total_spent: 0,
        tier: "Bronze",
      });
      toast.success("Customer enrolled in the loyalty program");
      setSelectedCustomerId("");
      await loadLoyaltyMembers();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to enroll customer",
      );
    } finally {
      setEnrolling(false);
    }
  };

  const unenrolledCustomers = customers.filter(
    (customer) => !members.some((member) => member.customer_id === customer.id),
  );

  const calculateTier = (totalSpent: number | string) => {
    const totalSpentCents = BigInt(
      parseKesToCents(String(totalSpent)),
    );
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (
        totalSpentCents >=
        BigInt(parseKesToCents(String(tiers[i].min)))
      ) {
        return tiers[i];
      }
    }
    return tiers[0];
  };

  const addPoints = async (memberId: string, points: number) => {
    try {
      const member = members.find((m) => m.id === memberId);
      if (!member) return;

      await ApiService.post(`/loyalty/members/${memberId}/points`, {
        points,
        amount: 0,
      });
      toast.success("Points added", {
        description: `${points} points added successfully`,
      });
      loadLoyaltyMembers();
    } catch (error) {
      toast.error(error.message || "Error adding points");
    }
  };

  const redeemPoints = async (memberId: string, points: number) => {
    try {
      const member = members.find((m) => m.id === memberId);
      if (!member || member.points < points) {
        toast.error("Insufficient points", {
          description: "Customer does not have enough points",
        });
        return;
      }

      await ApiService.post(`/loyalty/members/${memberId}/redeem`, { points });
      toast.success("Points redeemed", {
        description: `${points} points redeemed successfully`,
      });
      loadLoyaltyMembers();
    } catch (error) {
      toast.error(error.message || "Error redeeming points");
    }
  };

  const filteredMembers = members.filter(
    (member) => {
      const name = member.customer?.name || "";
      const phone = member.customer?.phone || "";
      const query = searchTerm.trim().toLowerCase();
      return name.toLowerCase().includes(query) || phone.toLowerCase().includes(query);
    },
  );

  const stats = {
    totalMembers: members.length,
    totalPoints: members.reduce((sum, m) => sum + m.points, 0),
    totalSpentCents: members.reduce(
      (sum, member) =>
        sum + BigInt(parseKesToCents(String(member.total_spent))),
      0n,
    ),
    avgPoints:
      members.length > 0
        ? Math.round(
            members.reduce((sum, m) => sum + m.points, 0) / members.length,
          )
        : 0,
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">
            Customer Loyalty Program
          </h1>
          <p className="text-muted-foreground">
            Reward your best customers • {loyaltySettings.pointsRate} point(s)
            per KSh {loyaltySettings.pointsPerAmount} spent
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            aria-label="Registered customer to enroll"
            value={selectedCustomerId}
            onChange={(event) => setSelectedCustomerId(event.target.value)}
            disabled={enrolling || unenrolledCustomers.length === 0}
            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">
              {unenrolledCustomers.length > 0
                ? "Select customer to enroll"
                : "All customers enrolled"}
            </option>
            {unenrolledCustomers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} ({customer.phone})
              </option>
            ))}
          </select>
          <Button
            onClick={enrollCustomer}
            disabled={enrolling || !selectedCustomerId}
          >
            {enrolling ? "Enrolling..." : "Enroll customer"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void loadLoyaltyMembers();
              void loadCustomers();
            }}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Loyalty Customers</p>
                <p className="text-2xl font-bold">{stats.totalMembers}</p>
              </div>
              <Users className="h-8 w-8 text-primary" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Points</p>
                <p className="text-2xl font-bold">
                  {stats.totalPoints.toLocaleString()}
                </p>
              </div>
              <Award className="h-8 w-8 text-accent" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Spent</p>
                <p className="text-2xl font-bold">
                  {formatKesCents(stats.totalSpentCents)}
                </p>
              </div>
              <TrendingUp className="h-8 w-8 text-primary" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Avg Points</p>
                <p className="text-2xl font-bold">{stats.avgPoints}</p>
              </div>
              <Star className="h-8 w-8 text-accent" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tier Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5" />
            Loyalty Tiers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {tiers.map((tier) => (
              <div key={tier.name} className="p-4 border rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-4 h-4 rounded-full ${tier.color}`} />
                  <h3 className="font-semibold">{tier.name}</h3>
                </div>
                <p className="text-sm text-muted-foreground mb-1">
                  Min. Spend: {formatKesCents(parseKesToCents(String(tier.min)))}
                </p>
                <p className="text-sm font-medium">
                  {tier.pointsMultiplier}x Points
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Members Table */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <CardTitle>Loyalty Customers</CardTitle>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search loyalty customers..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden sm:table-cell">Phone</TableHead>
                  <TableHead>Points</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Total Spent
                  </TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8">
                      Loading loyalty customers...
                    </TableCell>
                  </TableRow>
                ) : filteredMembers.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-8 text-muted-foreground"
                    >
                      No loyalty customers found. Enroll a customer or record a
                      qualifying purchase to add them to the program.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredMembers.map((member) => {
                    const tier = calculateTier(member.total_spent);
                    return (
                      <TableRow key={member.id}>
                        <TableCell className="font-medium">
                          {member.customer?.name || "Unknown"}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {member.customer?.phone}
                        </TableCell>
                        <TableCell className="font-semibold text-primary">
                          {member.points.toLocaleString()} pts
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {formatKesCents(
                            parseKesToCents(String(member.total_spent)),
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge className={tier.color}>{tier.name}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => addPoints(member.id, 100)}
                            >
                              +100
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => redeemPoints(member.id, 50)}
                            >
                              -50
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
